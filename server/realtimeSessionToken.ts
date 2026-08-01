import { createHmac, timingSafeEqual } from "node:crypto";

export const REALTIME_SESSION_TOKEN_HEADER = "X-KB-Realtime-Session";
export const REALTIME_SESSION_TOKEN_TTL_MS = 15 * 60 * 1_000;
export const MAX_REALTIME_SESSION_TOKEN_BYTES = 1_024;

export type RealtimeVoiceProfileId = "male-command" | "female-command";

export type VerifiedRealtimeSession = Readonly<{
  callId: string;
  profile: RealtimeVoiceProfileId;
}>;

type SessionTokenPayload = {
  v: 1;
  callId: string;
  profile: RealtimeVoiceProfileId;
  clientId: string;
  expiresAt: number;
};

const CALL_ID_PATTERN = /^rtc_[A-Za-z0-9_-]{8,192}$/;
const CLIENT_ID_PATTERN = /^kb_anon_[a-f0-9]{56}$/;
const TOKEN_PREFIX = "kb1";
const TOKEN_CONTEXT = "kb-form-realtime-session-token:v1\0";

function validProfile(value: unknown): value is RealtimeVoiceProfileId {
  return value === "male-command" || value === "female-command";
}

function validCallId(value: unknown): value is string {
  return typeof value === "string" && CALL_ID_PATTERN.test(value);
}

function signature(payloadSegment: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(TOKEN_CONTEXT)
    .update(payloadSegment)
    .digest();
}

export function realtimeCallIdFromLocation(location: string | null): string | null {
  if (!location || location.length > 512) {
    return null;
  }
  try {
    const parsed = new URL(location, "https://api.openai.com");
    if (
      parsed.origin !== "https://api.openai.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const match = parsed.pathname.match(/^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]{8,192})$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function issueRealtimeSessionToken({
  callId,
  profile,
  privacySafeClientId,
  secret,
  now = Date.now()
}: {
  callId: string;
  profile: RealtimeVoiceProfileId;
  privacySafeClientId: string;
  secret: string;
  now?: number;
}): string {
  if (
    !validCallId(callId) ||
    !validProfile(profile) ||
    !CLIENT_ID_PATTERN.test(privacySafeClientId) ||
    !secret
  ) {
    throw new Error("Invalid realtime session token input.");
  }
  const payload: SessionTokenPayload = {
    v: 1,
    callId,
    profile,
    clientId: privacySafeClientId,
    expiresAt: now + REALTIME_SESSION_TOKEN_TTL_MS
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signatureSegment = signature(payloadSegment, secret).toString("base64url");
  return `${TOKEN_PREFIX}.${payloadSegment}.${signatureSegment}`;
}

export function verifyRealtimeSessionToken({
  token,
  privacySafeClientId,
  secret,
  now = Date.now()
}: {
  token: string;
  privacySafeClientId: string;
  secret: string;
  now?: number;
}): VerifiedRealtimeSession | null {
  if (
    !token ||
    Buffer.byteLength(token, "utf8") > MAX_REALTIME_SESSION_TOKEN_BYTES ||
    !CLIENT_ID_PATTERN.test(privacySafeClientId) ||
    !secret
  ) {
    return null;
  }

  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "")
  ) {
    return null;
  }

  let suppliedSignature: Buffer;
  let payload: unknown;
  try {
    suppliedSignature = Buffer.from(parts[2], "base64url");
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const expectedSignature = signature(parts[1], secret);
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as Partial<SessionTokenPayload>;
  const keys = Object.keys(candidate).sort().join(",");
  if (
    keys !== "callId,clientId,expiresAt,profile,v" ||
    candidate.v !== 1 ||
    !validCallId(candidate.callId) ||
    !validProfile(candidate.profile) ||
    candidate.clientId !== privacySafeClientId ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    (candidate.expiresAt as number) <= now
  ) {
    return null;
  }

  return Object.freeze({
    callId: candidate.callId,
    profile: candidate.profile
  });
}
