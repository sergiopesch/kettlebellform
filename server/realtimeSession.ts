import { createHmac } from "node:crypto";
import {
  issueRealtimeSessionToken,
  realtimeCallIdFromLocation,
  REALTIME_SESSION_TOKEN_HEADER,
  type RealtimeVoiceProfileId
} from "./realtimeSessionToken.js";

export const REALTIME_SESSION_PATH = "/api/realtime-session";
export const MAX_SDP_BYTES = 32 * 1024;

export type CoachVoiceProfileId = RealtimeVoiceProfileId;

export type RealtimeSessionEnvironment = {
  OPENAI_API_KEY?: string;
  KB_FORM_ALLOWED_ORIGINS?: string;
  KB_FORM_SAFETY_ID_SECRET?: string;
};

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type RateLimitLease =
  | { allowed: true; release: () => void }
  | { allowed: false; retryAfterSeconds: number };

export type RealtimeSessionRateLimiter = {
  acquire: (privacySafeClientId: string) => RateLimitLease;
};

type RealtimeSessionDependencies = {
  environment?: RealtimeSessionEnvironment;
  fetch?: FetchImplementation;
  rateLimiter?: RealtimeSessionRateLimiter;
};

type ProcessLocalRateLimiterOptions = {
  maxRequestsPerWindow?: number;
  maxConcurrentRequests?: number;
  windowMs?: number;
  maxTrackedClients?: number;
  now?: () => number;
};

type ClientLimitState = {
  windowStartedAt: number;
  requestCount: number;
  inFlight: number;
};

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const UPSTREAM_TIMEOUT_MS = 12_000;
const MAX_UPSTREAM_SDP_BYTES = 64 * 1024;

const PROFILE_CONFIG: Record<CoachVoiceProfileId, { voice: "cedar" | "marin"; persona: string }> = {
  "male-command": {
    voice: "cedar",
    persona:
      "Use a lower-register British command voice: calm, crisp, disciplined, concise, and authoritative without shouting or aggression."
  },
  "female-command": {
    voice: "marin",
    persona:
      "Use a clear British command voice: calm, crisp, disciplined, concise, and authoritative without shouting or aggression."
  }
};

const DEFAULT_RATE_LIMITER = createProcessLocalBestEffortRateLimiter();

/**
 * A concurrency-safe limiter within one JavaScript process. It is deliberately
 * named "process local": serverless instances do not share this Map, so the
 * deployment still needs a durable edge/WAF rate limit and a project spend cap.
 */
export function createProcessLocalBestEffortRateLimiter({
  maxRequestsPerWindow = 6,
  maxConcurrentRequests = 2,
  windowMs = 60_000,
  maxTrackedClients = 10_000,
  now = Date.now
}: ProcessLocalRateLimiterOptions = {}): RealtimeSessionRateLimiter {
  const clients = new Map<string, ClientLimitState>();

  const removeExpiredIdleClients = (timestamp: number) => {
    for (const [clientId, state] of clients) {
      if (state.inFlight === 0 && timestamp - state.windowStartedAt >= windowMs) {
        clients.delete(clientId);
      }
    }
  };

  return {
    acquire(clientId) {
      const timestamp = now();
      let state = clients.get(clientId);

      if (state && timestamp - state.windowStartedAt >= windowMs && state.inFlight === 0) {
        state = undefined;
        clients.delete(clientId);
      }

      if (!state) {
        if (clients.size >= maxTrackedClients) {
          removeExpiredIdleClients(timestamp);
        }
        if (clients.size >= maxTrackedClients) {
          const oldestIdleClient = Array.from(clients).find(([, entry]) => entry.inFlight === 0);
          if (oldestIdleClient) {
            clients.delete(oldestIdleClient[0]);
          } else {
            return { allowed: false, retryAfterSeconds: 1 };
          }
        }
        state = { windowStartedAt: timestamp, requestCount: 0, inFlight: 0 };
        clients.set(clientId, state);
      }

      if (state.inFlight >= maxConcurrentRequests || state.requestCount >= maxRequestsPerWindow) {
        const remainingWindowMs = Math.max(1_000, windowMs - (timestamp - state.windowStartedAt));
        return {
          allowed: false,
          retryAfterSeconds:
            state.inFlight >= maxConcurrentRequests ? 1 : Math.ceil(remainingWindowMs / 1_000)
        };
      }

      state.requestCount += 1;
      state.inFlight += 1;
      let released = false;

      return {
        allowed: true,
        release() {
          if (released) {
            return;
          }
          released = true;
          state.inFlight = Math.max(0, state.inFlight - 1);
        }
      };
    }
  };
}

export function realtimeNoStoreHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    Vary: "Origin"
  });
}

export function realtimeErrorResponse(
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): Response {
  const headers = realtimeNoStoreHeaders("application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== value) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function realtimeOriginAllowed(
  request: Request,
  environment: RealtimeSessionEnvironment
): boolean {
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) {
    return false;
  }

  const normalizedSuppliedOrigin = normalizeOrigin(suppliedOrigin);
  if (!normalizedSuppliedOrigin) {
    return false;
  }

  const allowedOrigins = new Set<string>([new URL(request.url).origin]);
  for (const candidate of environment.KB_FORM_ALLOWED_ORIGINS?.split(",") ?? []) {
    const normalized = normalizeOrigin(candidate.trim());
    if (normalized) {
      allowedOrigins.add(normalized);
    }
  }
  return allowedOrigins.has(normalizedSuppliedOrigin);
}

function profileFromRequest(request: Request): CoachVoiceProfileId | null {
  const url = new URL(request.url);
  const profiles = url.searchParams.getAll("profile");
  const unexpectedParameter = Array.from(url.searchParams.keys()).some((key) => key !== "profile");
  if (profiles.length !== 1 || unexpectedParameter) {
    return null;
  }
  const profile = profiles[0];
  return profile === "male-command" || profile === "female-command" ? profile : null;
}

function forwardedClientAddress(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("cf-connecting-ip") ??
    "unknown";
  return forwarded.split(",", 1)[0]?.trim().slice(0, 128) || "unknown";
}

export function realtimePrivacySafeClientId(
  request: Request,
  apiKey: string,
  environment: RealtimeSessionEnvironment
): string {
  const secret = environment.KB_FORM_SAFETY_ID_SECRET?.trim() || apiKey;
  const digest = createHmac("sha256", secret)
    .update("kb-form-realtime-safety:v1\0")
    .update(forwardedClientAddress(request))
    .digest("hex");
  return `kb_anon_${digest.slice(0, 56)}`;
}

function validOfferSdp(sdp: string): boolean {
  const lines = sdp.split("\r\n");
  if (lines[0]?.trim() !== "v=0" || lines.length > 1_000) {
    return false;
  }
  if (lines.some((line) => line.length > 4_096)) {
    return false;
  }

  const sections: Array<{ kind: string; firstLine: string; lines: string[] }> = [];
  let currentSection: { kind: string; firstLine: string; lines: string[] } | null = null;
  for (const untrimmedLine of lines) {
    const line = untrimmedLine.trim();
    if (line.startsWith("m=")) {
      const kind = line.slice(2).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      currentSection = { kind, firstLine: line, lines: [line] };
      sections.push(currentSection);
    } else if (currentSection) {
      currentSection.lines.push(line);
    }
  }

  if (sections.some((section) => section.kind !== "audio")) {
    return false;
  }

  const audioSections = sections.filter((section) => section.kind === "audio");
  if (audioSections.length !== 1) {
    return false;
  }

  const audioLines = new Set(audioSections[0].lines.map((line) => line.toLowerCase()));
  if (
    !audioLines.has("a=recvonly") ||
    audioLines.has("a=sendrecv") ||
    audioLines.has("a=sendonly")
  ) {
    return false;
  }
  return true;
}

function validAnswerSdp(sdp: string): boolean {
  const lines = sdp.split("\r\n");
  if (lines[0]?.trim() !== "v=0" || lines.length > 1_000) {
    return false;
  }
  if (lines.some((line) => line.length > 4_096)) {
    return false;
  }
  const mediaLines = lines
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.startsWith("m="));
  return mediaLines.length === 1 && mediaLines[0].startsWith("m=audio ");
}

function sessionConfiguration(profile: CoachVoiceProfileId): string {
  const config = PROFILE_CONFIG[profile];
  return JSON.stringify({
    type: "realtime",
    model: "gpt-realtime-2.1",
    output_modalities: ["audio"],
    audio: {
      output: {
        voice: config.voice
      }
    },
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "none",
    max_output_tokens: 96,
    instructions: [
      "You are KB FORM's output-only AI framing-cue voice renderer.",
      config.persona,
      "Speak only the exact short camera-positioning cue supplied by KB FORM after the words SAY EXACTLY.",
      "Never answer questions, continue a conversation, add advice, diagnose, motivate, improvise, or add words before or after the supplied cue."
    ].join(" ")
  });
}

function contentLengthExceeds(headers: Headers, maximum: number): boolean {
  const raw = headers.get("content-length");
  if (!raw) {
    return false;
  }
  const parsed = Number(raw);
  return !Number.isFinite(parsed) || parsed < 0 || parsed > maximum;
}

type BoundedUtf8Result =
  | { ok: true; value: string }
  | { ok: false; tooLarge: boolean };

async function cancelStream(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) {
    return;
  }
  try {
    await stream.cancel();
  } catch {
    // Cancellation is a best-effort resource cleanup after a rejected response.
  }
}

async function boundedUtf8Stream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number
): Promise<BoundedUtf8Result> {
  if (!stream) {
    return { ok: false, tooLarge: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size rejection remains authoritative even if cancellation fails.
      }
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  if (byteLength === 0) {
    return { ok: false, tooLarge: false };
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

function canonicalizeSdp(sdp: string, maximumBytes: number): string | null {
  if (sdp.includes("\0") || /\r(?!\n)/u.test(sdp)) {
    return null;
  }
  const canonical = sdp.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  return new TextEncoder().encode(canonical).byteLength <= maximumBytes ? canonical : null;
}

async function boundedUtf8Body(request: Request): Promise<BoundedUtf8Result> {
  if (contentLengthExceeds(request.headers, MAX_SDP_BYTES)) {
    return { ok: false, tooLarge: true };
  }
  return boundedUtf8Stream(request.body, MAX_SDP_BYTES);
}

export function createRealtimeSessionHandler({
  environment = process.env,
  fetch: fetchImplementation = globalThis.fetch,
  rateLimiter = DEFAULT_RATE_LIMITER
}: RealtimeSessionDependencies = {}) {
  return async function handleRealtimeSessionRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return realtimeErrorResponse(405, "Realtime voice session request was not accepted.", {
        Allow: "POST"
      });
    }

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/sdp") {
      return realtimeErrorResponse(415, "Realtime voice session request was not accepted.");
    }

    if (!realtimeOriginAllowed(request, environment)) {
      return realtimeErrorResponse(403, "Realtime voice session request was not accepted.");
    }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite !== "same-origin") {
      return realtimeErrorResponse(403, "Realtime voice session request was not accepted.");
    }

    const profile = profileFromRequest(request);
    if (!profile) {
      return realtimeErrorResponse(400, "Realtime voice session request was not accepted.");
    }

    const apiKey = environment.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return realtimeErrorResponse(503, "Realtime voice is temporarily unavailable.");
    }

    const safetyId = realtimePrivacySafeClientId(request, apiKey, environment);
    const lease = rateLimiter.acquire(safetyId);
    if (!lease.allowed) {
      return realtimeErrorResponse(429, "Realtime voice is temporarily busy.", {
        "Retry-After": String(lease.retryAfterSeconds)
      });
    }

    try {
      const offerBody = await boundedUtf8Body(request);
      if (!offerBody.ok) {
        return realtimeErrorResponse(
          offerBody.tooLarge ? 413 : 400,
          "Realtime voice session request was not accepted."
        );
      }
      const offerSdp = canonicalizeSdp(offerBody.value, MAX_SDP_BYTES);
      if (!offerSdp || !validOfferSdp(offerSdp)) {
        return realtimeErrorResponse(400, "Realtime voice session request was not accepted.");
      }

      const form = new FormData();
      form.set("sdp", offerSdp);
      form.set("session", sessionConfiguration(profile));

      const abortController = new AbortController();
      const abortFromClient = () => abortController.abort();
      if (request.signal.aborted) {
        abortController.abort();
      } else {
        request.signal.addEventListener("abort", abortFromClient, { once: true });
      }
      const timeout = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

      try {
        const upstream = await fetchImplementation(OPENAI_REALTIME_CALLS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Safety-Identifier": safetyId
          },
          body: form,
          signal: abortController.signal
        });

        const upstreamContentType = upstream.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (
          !upstream.ok ||
          (upstreamContentType !== "application/sdp" && upstreamContentType !== "text/plain") ||
          contentLengthExceeds(upstream.headers, MAX_UPSTREAM_SDP_BYTES)
        ) {
          await cancelStream(upstream.body);
          return realtimeErrorResponse(502, "Realtime voice is temporarily unavailable.");
        }

        const answerBody = await boundedUtf8Stream(upstream.body, MAX_UPSTREAM_SDP_BYTES);
        if (!answerBody.ok) {
          return realtimeErrorResponse(502, "Realtime voice is temporarily unavailable.");
        }
        const answerSdp = canonicalizeSdp(answerBody.value, MAX_UPSTREAM_SDP_BYTES);
        if (!answerSdp || !validAnswerSdp(answerSdp)) {
          return realtimeErrorResponse(502, "Realtime voice is temporarily unavailable.");
        }

        const callId = realtimeCallIdFromLocation(upstream.headers.get("location"));
        if (!callId) {
          return realtimeErrorResponse(502, "Realtime voice is temporarily unavailable.");
        }
        const token = issueRealtimeSessionToken({
          callId,
          profile,
          privacySafeClientId: safetyId,
          secret: environment.KB_FORM_SAFETY_ID_SECRET?.trim() || apiKey
        });
        const headers = realtimeNoStoreHeaders("application/sdp");
        headers.set(REALTIME_SESSION_TOKEN_HEADER, token);

        return new Response(answerSdp, {
          status: 200,
          headers
        });
      } catch {
        return realtimeErrorResponse(
          abortController.signal.aborted ? 504 : 502,
          "Realtime voice is temporarily unavailable."
        );
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abortFromClient);
      }
    } catch {
      return realtimeErrorResponse(400, "Realtime voice session request was not accepted.");
    } finally {
      lease.release();
    }
  };
}

export const handleRealtimeSessionRequest = createRealtimeSessionHandler();
