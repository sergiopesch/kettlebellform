import { randomUUID } from "node:crypto";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  COACH_VOICE_MESSAGES,
  isCoachVoiceMessageId,
  type CoachVoiceMessageId
} from "../src/lib/coachVoicePolicy.js";
import {
  createProcessLocalBestEffortRateLimiter,
  realtimeErrorResponse,
  realtimeNoStoreHeaders,
  realtimeOriginAllowed,
  realtimePrivacySafeClientId,
  type RealtimeSessionEnvironment,
  type RealtimeSessionRateLimiter
} from "./realtimeSession.js";
import {
  MAX_REALTIME_SESSION_TOKEN_BYTES,
  REALTIME_SESSION_TOKEN_HEADER,
  verifyRealtimeSessionToken,
  type VerifiedRealtimeSession
} from "./realtimeSessionToken.js";

export const REALTIME_CUE_PATH = "/api/realtime-cue";
export const MAX_REALTIME_CUE_BODY_BYTES = 256;
export const REALTIME_CUE_TIMEOUT_MS = 10_000;
export const MAX_REALTIME_SIDEBAND_EVENT_BYTES = 64 * 1_024;
export const MAX_REALTIME_SIDEBAND_TOTAL_BYTES = 512 * 1_024;
const MAX_REALTIME_SIDEBAND_EVENTS = 256;
const CANCEL_SETTLE_MS = 250;

type RealtimeCueAction =
  | Readonly<{ action: "speak"; cueId: CoachVoiceMessageId }>
  | Readonly<{ action: "cancel" }>;

type SidebandWebSocket = Pick<
  WebSocket,
  "close" | "on" | "once" | "removeAllListeners" | "send" | "terminate"
>;

type SidebandWebSocketFactory = (
  url: string,
  options: ClientOptions
) => SidebandWebSocket;

type RealtimeSidebandRequest = Readonly<{
  action: RealtimeCueAction;
  apiKey: string;
  session: VerifiedRealtimeSession;
  signal: AbortSignal;
}>;

type RealtimeCueDependencies = {
  environment?: RealtimeSessionEnvironment;
  rateLimiter?: RealtimeSessionRateLimiter;
  runSideband?: (request: RealtimeSidebandRequest) => Promise<void>;
};

const DEFAULT_CUE_RATE_LIMITER = createProcessLocalBestEffortRateLimiter({
  maxRequestsPerWindow: 24,
  maxConcurrentRequests: 2,
  windowMs: 60_000
});

function defaultSidebandWebSocketFactory(
  url: string,
  options: ClientOptions
): SidebandWebSocket {
  return new WebSocket(url, options);
}

function byteLengthOfRawData(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function textFromRawData(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ignoreSidebandShutdownError(): void {
  // `ws` emits an error when a CONNECTING socket is closed. Keep shutdown
  // failures contained after the request's own promise has already settled.
}

export function runRealtimeCueOverSideband(
  request: RealtimeSidebandRequest,
  createWebSocket: SidebandWebSocketFactory = defaultSidebandWebSocketFactory
): Promise<void> {
  const { action, apiKey, session, signal } = request;
  const requestId = randomUUID();
  const cancelEventId = `kb-cancel-${requestId}`;
  const clearEventId = `kb-clear-${requestId}`;
  const responseEventId = `kb-cue-${requestId}`;

  return new Promise<void>((resolve, reject) => {
    let socket: SidebandWebSocket;
    try {
      socket = createWebSocket(
        `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(session.callId)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          handshakeTimeout: 5_000,
          maxPayload: MAX_REALTIME_SIDEBAND_EVENT_BYTES,
          perMessageDeflate: false
        }
      );
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let matchingResponseDone = false;
    let matchingResponseCancelled = false;
    let matchingResponseId: string | null = null;
    let eventCount = 0;
    let totalEventBytes = 0;
    const clearedResponseIds = new Set<string>();
    const stoppedResponseIds = new Set<string>();
    let cancelSettleTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => finish(new Error("Realtime cue timed out.")), REALTIME_CUE_TIMEOUT_MS);

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (cancelSettleTimer) {
        clearTimeout(cancelSettleTimer);
      }
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", ignoreSidebandShutdownError);
      try {
        socket.close(1000);
      } catch {
        socket.terminate();
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const finishAfterCancelGrace = () => {
      if (cancelSettleTimer === null) {
        cancelSettleTimer = setTimeout(() => finish(), CANCEL_SETTLE_MS);
      }
    };

    const onAbort = () => finish(new Error("Realtime cue request was cancelled."));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    socket.once("open", () => {
      try {
        socket.send(JSON.stringify({ event_id: cancelEventId, type: "response.cancel" }));
        socket.send(JSON.stringify({ event_id: clearEventId, type: "output_audio_buffer.clear" }));

        if (action.action === "cancel") {
          finishAfterCancelGrace();
          return;
        }

        const speech = COACH_VOICE_MESSAGES[action.cueId];
        socket.send(JSON.stringify({
          event_id: responseEventId,
          type: "response.create",
          response: {
            input: [],
            instructions: `SAY EXACTLY: ${JSON.stringify(speech)}`,
            max_output_tokens: 80,
            metadata: {
              source: "kb-form-framing",
              cue_id: action.cueId,
              request_id: requestId,
              profile: session.profile
            },
            output_modalities: ["audio"]
          }
        }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Realtime cue send failed."));
      }
    });

    socket.on("message", (data: RawData) => {
      eventCount += 1;
      const eventBytes = byteLengthOfRawData(data);
      totalEventBytes += eventBytes;
      if (
        eventCount > MAX_REALTIME_SIDEBAND_EVENTS ||
        eventBytes > MAX_REALTIME_SIDEBAND_EVENT_BYTES ||
        totalEventBytes > MAX_REALTIME_SIDEBAND_TOTAL_BYTES
      ) {
        finish(new Error("Realtime cue event limit exceeded."));
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(textFromRawData(data));
      } catch {
        return;
      }
      if (!isObject(payload) || typeof payload.type !== "string") {
        return;
      }

      if (action.action === "cancel") {
        if (
          payload.type === "output_audio_buffer.cleared" ||
          payload.type === "output_audio_buffer.stopped"
        ) {
          finish();
        }
        return;
      }

      if (payload.type === "error") {
        const error = payload.error;
        const relatedEventId = isObject(error) && typeof error.event_id === "string"
          ? error.event_id
          : null;
        if (relatedEventId === responseEventId) {
          finish(new Error("Realtime cue response failed."));
        }
        return;
      }

      if (payload.type === "response.created") {
        const response = payload.response;
        if (
          isObject(response) &&
          typeof response.id === "string" &&
          isObject(response.metadata) &&
          response.metadata.request_id === requestId
        ) {
          matchingResponseId = response.id;
        }
        return;
      }

      if (payload.type === "response.done") {
        const response = payload.response;
        if (
          !isObject(response) ||
          typeof response.id !== "string" ||
          !isObject(response.metadata)
        ) {
          return;
        }
        if (response.metadata.request_id !== requestId) {
          return;
        }
        if (matchingResponseId && matchingResponseId !== response.id) {
          return;
        }
        matchingResponseId = response.id;
        if (response.status !== "completed" && response.status !== "cancelled") {
          finish(new Error("Realtime cue response failed."));
          return;
        }
        matchingResponseCancelled = response.status === "cancelled";
        matchingResponseDone = true;
        if (
          (matchingResponseCancelled && clearedResponseIds.has(response.id)) ||
          stoppedResponseIds.has(response.id)
        ) {
          finish();
        } else if (matchingResponseCancelled) {
          finishAfterCancelGrace();
        }
        return;
      }

      if (
        (payload.type === "output_audio_buffer.stopped" ||
          payload.type === "output_audio_buffer.cleared") &&
        typeof payload.response_id === "string"
      ) {
        if (payload.type === "output_audio_buffer.stopped") {
          stoppedResponseIds.add(payload.response_id);
        } else {
          clearedResponseIds.add(payload.response_id);
        }
        if (
          matchingResponseDone &&
          payload.response_id === matchingResponseId &&
          (payload.type === "output_audio_buffer.stopped" || matchingResponseCancelled)
        ) {
          finish();
        }
      }
    });

    socket.once("error", () => finish(new Error("Realtime sideband connection failed.")));
    socket.once("close", () => {
      if (!settled) {
        finish(new Error("Realtime sideband connection closed."));
      }
    });
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

async function boundedCueBody(request: Request): Promise<string | null> {
  if (contentLengthExceeds(request.headers, MAX_REALTIME_CUE_BODY_BYTES) || !request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > MAX_REALTIME_CUE_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (length === 0) {
    return null;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseCueAction(body: string): RealtimeCueAction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed).sort().join(",");
  if (parsed.action === "cancel" && keys === "action") {
    return Object.freeze({ action: "cancel" });
  }
  if (
    parsed.action === "speak" &&
    keys === "action,cueId" &&
    isCoachVoiceMessageId(parsed.cueId)
  ) {
    return Object.freeze({ action: "speak", cueId: parsed.cueId });
  }
  return null;
}

export function createRealtimeCueHandler({
  environment = process.env,
  rateLimiter = DEFAULT_CUE_RATE_LIMITER,
  runSideband = runRealtimeCueOverSideband
}: RealtimeCueDependencies = {}) {
  return async function handleRealtimeCueRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return realtimeErrorResponse(405, "Realtime voice cue request was not accepted.", {
        Allow: "POST"
      });
    }
    const url = new URL(request.url);
    if (url.search) {
      return realtimeErrorResponse(400, "Realtime voice cue request was not accepted.");
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return realtimeErrorResponse(415, "Realtime voice cue request was not accepted.");
    }
    if (
      !realtimeOriginAllowed(request, environment) ||
      request.headers.get("sec-fetch-site") !== "same-origin"
    ) {
      return realtimeErrorResponse(403, "Realtime voice cue request was not accepted.");
    }

    const apiKey = environment.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return realtimeErrorResponse(503, "Realtime voice is temporarily unavailable.");
    }
    const privacySafeClientId = realtimePrivacySafeClientId(request, apiKey, environment);
    const token = request.headers.get(REALTIME_SESSION_TOKEN_HEADER);
    if (
      !token ||
      Buffer.byteLength(token, "utf8") > MAX_REALTIME_SESSION_TOKEN_BYTES
    ) {
      return realtimeErrorResponse(403, "Realtime voice cue request was not accepted.");
    }
    const session = verifyRealtimeSessionToken({
      token,
      privacySafeClientId,
      secret: environment.KB_FORM_SAFETY_ID_SECRET?.trim() || apiKey
    });
    if (!session) {
      return realtimeErrorResponse(403, "Realtime voice cue request was not accepted.");
    }

    const body = await boundedCueBody(request);
    const action = body === null ? null : parseCueAction(body);
    if (!action) {
      return realtimeErrorResponse(
        contentLengthExceeds(request.headers, MAX_REALTIME_CUE_BODY_BYTES) ? 413 : 400,
        "Realtime voice cue request was not accepted."
      );
    }

    const lease = rateLimiter.acquire(privacySafeClientId);
    if (!lease.allowed) {
      return realtimeErrorResponse(429, "Realtime voice is temporarily busy.", {
        "Retry-After": String(lease.retryAfterSeconds)
      });
    }
    try {
      await runSideband({ action, apiKey, session, signal: request.signal });
      return new Response(null, {
        status: 204,
        headers: realtimeNoStoreHeaders("application/json; charset=utf-8")
      });
    } catch {
      return realtimeErrorResponse(
        request.signal.aborted ? 499 : 502,
        "Realtime voice is temporarily unavailable."
      );
    } finally {
      lease.release();
    }
  };
}

export const handleRealtimeCueRequest = createRealtimeCueHandler();
