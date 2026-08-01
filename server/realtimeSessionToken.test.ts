// @vitest-environment node

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_REALTIME_SESSION_TOKEN_BYTES,
  REALTIME_SESSION_TOKEN_TTL_MS,
  issueRealtimeSessionToken,
  realtimeCallIdFromLocation,
  verifyRealtimeSessionToken,
  type RealtimeVoiceProfileId
} from "./realtimeSessionToken";

const NOW = 1_900_000_000_000;
const CALL_ID = "rtc_call_123456789";
const CLIENT_ID = `kb_anon_${"a".repeat(56)}`;
const OTHER_CLIENT_ID = `kb_anon_${"b".repeat(56)}`;
const SECRET = "unit-test-signing-secret";
const TOKEN_CONTEXT = "kb-form-realtime-session-token:v1\0";

type SignedPayload = {
  v: unknown;
  callId: unknown;
  profile: unknown;
  clientId: unknown;
  expiresAt: unknown;
  [key: string]: unknown;
};

function signPayload(payload: SignedPayload, secret = SECRET): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(TOKEN_CONTEXT)
    .update(payloadSegment)
    .digest("base64url");
  return `kb1.${payloadSegment}.${signature}`;
}

function validPayload(overrides: Partial<SignedPayload> = {}): SignedPayload {
  return {
    v: 1,
    callId: CALL_ID,
    profile: "male-command",
    clientId: CLIENT_ID,
    expiresAt: NOW + REALTIME_SESSION_TOKEN_TTL_MS,
    ...overrides
  };
}

describe("realtimeCallIdFromLocation", () => {
  it.each([
    [`https://api.openai.com/v1/realtime/calls/${CALL_ID}`, CALL_ID],
    [`/v1/realtime/calls/${CALL_ID}`, CALL_ID],
    [`//api.openai.com/v1/realtime/calls/${CALL_ID}`, CALL_ID],
    ["https://api.openai.com/v1/realtime/calls/rtc_ABCDEFGH", "rtc_ABCDEFGH"]
  ])("extracts a call ID only from the exact OpenAI calls path", (location, expected) => {
    expect(realtimeCallIdFromLocation(location)).toBe(expected);
  });

  it.each([
    null,
    "",
    `https://attacker.example/v1/realtime/calls/${CALL_ID}`,
    `https://api.openai.com.attacker.example/v1/realtime/calls/${CALL_ID}`,
    `https://api.openai.com:444/v1/realtime/calls/${CALL_ID}`,
    `https://user@api.openai.com/v1/realtime/calls/${CALL_ID}`,
    `https://api.openai.com/v1/realtime/calls/${CALL_ID}/extra`,
    `https://api.openai.com/v1/realtime/calls/${CALL_ID}/`,
    `https://api.openai.com/v1/realtime/calls/${CALL_ID}?debug=1`,
    `https://api.openai.com/v1/realtime/calls/${CALL_ID}#fragment`,
    "https://api.openai.com/v1/realtime/calls/rtc_short",
    "https://api.openai.com/v1/realtime/calls/call_123456789",
    "https://api.openai.com/v1/realtime/calls/rtc_bad%2Fsegment",
    `https://api.openai.com/v1/realtime/calls/rtc_${"a".repeat(193)}`,
    "x".repeat(513)
  ])("rejects an untrusted or malformed Location: %s", (location) => {
    expect(realtimeCallIdFromLocation(location)).toBeNull();
  });
});

describe("signed realtime session tokens", () => {
  it.each<RealtimeVoiceProfileId>(["male-command", "female-command"])(
    "round-trips a %s session and returns an immutable minimal claim",
    (profile) => {
      const token = issueRealtimeSessionToken({
        callId: CALL_ID,
        profile,
        privacySafeClientId: CLIENT_ID,
        secret: SECRET,
        now: NOW
      });

      expect(Buffer.byteLength(token, "utf8")).toBeLessThan(MAX_REALTIME_SESSION_TOKEN_BYTES);
      expect(token).toMatch(/^kb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      const verified = verifyRealtimeSessionToken({
        token,
        privacySafeClientId: CLIENT_ID,
        secret: SECRET,
        now: NOW
      });

      expect(verified).toEqual({ callId: CALL_ID, profile });
      expect(Object.isFrozen(verified)).toBe(true);
      expect(Object.keys(verified ?? {}).sort()).toEqual(["callId", "profile"]);
    }
  );

  it("uses an exact 15-minute lifetime and fails closed at the expiry instant", () => {
    const token = issueRealtimeSessionToken({
      callId: CALL_ID,
      profile: "male-command",
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    });

    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW + REALTIME_SESSION_TOKEN_TTL_MS - 1
    })).toEqual({ callId: CALL_ID, profile: "male-command" });
    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW + REALTIME_SESSION_TOKEN_TTL_MS
    })).toBeNull();
  });

  it("binds the token to the client identifier and signing secret", () => {
    const token = issueRealtimeSessionToken({
      callId: CALL_ID,
      profile: "female-command",
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    });

    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: OTHER_CLIENT_ID,
      secret: SECRET,
      now: NOW
    })).toBeNull();
    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: CLIENT_ID,
      secret: "wrong-secret",
      now: NOW
    })).toBeNull();
  });

  it.each([
    ["call ID", { callId: "rtc_attacker999" }],
    ["profile", { profile: "female-command" }],
    ["client identifier", { clientId: OTHER_CLIENT_ID }],
    ["expiry", { expiresAt: NOW + 99_999_999 }]
  ])("rejects a token whose signed %s claim was altered", (_label, change) => {
    const token = issueRealtimeSessionToken({
      callId: CALL_ID,
      profile: "male-command",
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    });
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as SignedPayload;
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, ...change }), "utf8")
      .toString("base64url");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    expect(verifyRealtimeSessionToken({
      token: tampered,
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    })).toBeNull();
  });

  it.each([
    ["wrong version", { v: 2 }],
    ["invalid call ID", { callId: "call_not_realtime" }],
    ["unknown profile", { profile: "custom" }],
    ["wrong client", { clientId: OTHER_CLIENT_ID }],
    ["expired", { expiresAt: NOW }],
    ["fractional expiry", { expiresAt: NOW + 0.5 }],
    ["unsafe expiry", { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["extra claim", { extra: "not-allowed" }]
  ])("rejects a correctly signed payload with %s", (_label, overrides) => {
    expect(verifyRealtimeSessionToken({
      token: signPayload(validPayload(overrides)),
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    })).toBeNull();
  });

  it.each([
    "",
    "kb1",
    "kb1.payload.signature.extra",
    "kb2.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "kb1.***.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "kb1.e30.short",
    `kb1.${Buffer.from("not json").toString("base64url")}.${"A".repeat(43)}`,
    "x".repeat(MAX_REALTIME_SESSION_TOKEN_BYTES + 1)
  ])("rejects a malformed token", (token) => {
    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    })).toBeNull();
  });

  it("rejects empty or malformed verification inputs", () => {
    const token = issueRealtimeSessionToken({
      callId: CALL_ID,
      profile: "male-command",
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW
    });

    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: "raw-address",
      secret: SECRET,
      now: NOW
    })).toBeNull();
    expect(verifyRealtimeSessionToken({
      token,
      privacySafeClientId: CLIENT_ID,
      secret: "",
      now: NOW
    })).toBeNull();
  });

  it.each([
    ["invalid call ID", { callId: "call_123" }],
    ["invalid profile", { profile: "custom" }],
    ["raw client address", { privacySafeClientId: "203.0.113.42" }],
    ["empty secret", { secret: "" }]
  ])("refuses to issue a token with %s", (_label, override) => {
    expect(() => issueRealtimeSessionToken({
      callId: CALL_ID,
      profile: "male-command",
      privacySafeClientId: CLIENT_ID,
      secret: SECRET,
      now: NOW,
      ...override
    } as Parameters<typeof issueRealtimeSessionToken>[0])).toThrow(
      "Invalid realtime session token input."
    );
  });
});
