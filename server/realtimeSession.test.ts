// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SDP_BYTES,
  createProcessLocalBestEffortRateLimiter,
  createRealtimeSessionHandler,
  type CoachVoiceProfileId,
  type RealtimeSessionEnvironment
} from "./realtimeSession";
import {
  REALTIME_SESSION_TOKEN_HEADER,
  verifyRealtimeSessionToken
} from "./realtimeSessionToken";

const APP_ORIGIN = "https://coach.example";
const CLIENT_ADDRESS = "203.0.113.42";
const CALL_ID = "rtc_testcall_123456";
const OFFER_SDP = [
  "v=0",
  "o=- 1 1 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=recvonly",
  "a=rtpmap:111 opus/48000/2",
  ""
].join("\r\n");
const ANSWER_SDP = OFFER_SDP.replace("a=recvonly", "a=sendonly");
const DATA_CHANNEL_SECTION = [
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:1",
  "a=sctp-port:5000",
  ""
].join("\r\n");

const environment: RealtimeSessionEnvironment = {
  OPENAI_API_KEY: "test-project-key",
  KB_FORM_ALLOWED_ORIGINS: APP_ORIGIN,
  KB_FORM_SAFETY_ID_SECRET: "test-safety-secret"
};

function request({
  body = OFFER_SDP,
  contentType = "application/sdp",
  fetchSite = "same-origin",
  method = "POST",
  origin = APP_ORIGIN,
  profile = "male-command",
  query,
  signal,
  headers: extraHeaders = {}
}: {
  body?: BodyInit | null;
  contentType?: string;
  fetchSite?: string | null;
  method?: string;
  origin?: string | null;
  profile?: string;
  query?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
} = {}): Request {
  const headers = new Headers({
    "Content-Type": contentType,
    "X-Forwarded-For": CLIENT_ADDRESS,
    ...extraHeaders
  });
  if (origin) {
    headers.set("Origin", origin);
  }
  if (fetchSite) {
    headers.set("Sec-Fetch-Site", fetchSite);
  }
  const search = query ?? `profile=${encodeURIComponent(profile)}`;
  return new Request(`${APP_ORIGIN}/api/realtime-session?${search}`, {
    method,
    headers,
    signal,
    body: method === "GET" || method === "HEAD" ? undefined : body
  });
}

function successfulFetch({
  answer = ANSWER_SDP,
  contentType = "application/sdp",
  location = `https://api.openai.com/v1/realtime/calls/${CALL_ID}`,
  status = 200
}: {
  answer?: string;
  contentType?: string;
  location?: string | null;
  status?: number;
} = {}) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const headers = new Headers({ "Content-Type": contentType });
    if (location !== null) {
      headers.set("Location", location);
    }
    return new Response(answer, { status, headers });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Realtime session server boundary", () => {
  it.each<[CoachVoiceProfileId, "cedar" | "marin"]>([
    ["male-command", "cedar"],
    ["female-command", "marin"]
  ])("maps %s to the server-owned %s voice and returns a signed call token", async (
    profile,
    expectedVoice
  ) => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request({ profile }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe(ANSWER_SDP);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [upstreamUrl, init] = fetchMock.mock.calls[0];
    expect(upstreamUrl).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-project-key" });

    const safetyId = new Headers(init?.headers).get("OpenAI-Safety-Identifier");
    expect(safetyId).toMatch(/^kb_anon_[a-f0-9]{56}$/);
    expect(safetyId).toHaveLength(64);
    expect(safetyId).not.toContain(CLIENT_ADDRESS);

    const form = init?.body as FormData;
    expect(form.get("sdp")).toBe(OFFER_SDP);
    expect(String(form.get("sdp"))).not.toContain("m=application");
    const session = JSON.parse(String(form.get("session"))) as Record<string, unknown>;
    expect(session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      audio: { output: { voice: expectedVoice } },
      reasoning: { effort: "low" },
      tools: [],
      tool_choice: "none",
      max_output_tokens: 96
    });
    expect(session).not.toHaveProperty("audio.input");
    expect(String(session.instructions)).toContain(
      "Speak only the exact short camera-positioning cue"
    );

    const token = response.headers.get(REALTIME_SESSION_TOKEN_HEADER);
    expect(token).toBeTruthy();
    expect(verifyRealtimeSessionToken({
      token: token ?? "",
      privacySafeClientId: safetyId ?? "",
      secret: "test-safety-secret"
    })).toEqual({ callId: CALL_ID, profile });
  });

  it("produces a stable privacy-safe identifier without exposing the client address", async () => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    await handler(request());
    await handler(request({ profile: "female-command" }));

    const identifiers = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("OpenAI-Safety-Identifier")
    );
    expect(identifiers[0]).toBe(identifiers[1]);
    expect(identifiers[0]).not.toContain(CLIENT_ADDRESS);
  });

  it("accepts the unified endpoint's 201 text/plain SDP and relative Location", async () => {
    const fetchMock = successfulFetch({
      status: 201,
      contentType: "text/plain; charset=utf-8",
      location: `/v1/realtime/calls/${CALL_ID}`
    });
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request({
      contentType: "application/sdp; charset=utf-8",
      profile: "female-command"
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get(REALTIME_SESSION_TOKEN_HEADER)).toBeTruthy();
    expect(await response.text()).toBe(ANSWER_SDP);
  });

  it.each([
    ["non-POST methods", request({ method: "GET" }), 405],
    ["non-SDP content", request({ contentType: "application/json" }), 415],
    ["missing Origin", request({ origin: null }), 403],
    ["untrusted Origin", request({ origin: "https://attacker.example" }), 403],
    ["malformed Origin", request({ origin: "https://coach.example/extra" }), 403],
    ["missing fetch metadata", request({ fetchSite: null }), 403],
    ["cross-site fetch metadata", request({ fetchSite: "cross-site" }), 403],
    ["unknown profiles", request({ profile: "custom" }), 400],
    ["duplicate profiles", request({ query: "profile=male-command&profile=female-command" }), 400],
    ["unexpected query parameters", request({ query: "profile=male-command&debug=true" }), 400],
    ["missing profile parameter", request({ query: "" }), 400]
  ])("rejects %s before contacting OpenAI", async (_label, invalidRequest, expectedStatus) => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(invalidRequest);

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a data channel", OFFER_SDP + DATA_CHANNEL_SECTION],
    ["video media", OFFER_SDP.replace("m=audio", "m=video")],
    ["sendrecv audio", OFFER_SDP.replace("a=recvonly", "a=sendrecv")],
    ["sendonly audio", OFFER_SDP.replace("a=recvonly", "a=sendonly")],
    ["inactive audio", OFFER_SDP.replace("a=recvonly", "a=inactive")],
    ["no explicit recvonly direction", OFFER_SDP.replace("a=recvonly\r\n", "")],
    ["two audio media sections", OFFER_SDP + OFFER_SDP.slice(OFFER_SDP.indexOf("m=audio"))],
    ["an unknown media section", OFFER_SDP + "m=message 9 TCP/MSRP *\r\n"],
    ["a NUL byte", OFFER_SDP + "\0"],
    ["an invalid first line", OFFER_SDP.replace("v=0", "v=1")],
    ["an overlong line", OFFER_SDP + `a=x:${"z".repeat(4_097)}\r\n`]
  ])("rejects an SDP offer containing %s", async (_label, body) => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request({ body }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a data-channel media section hidden behind a lone carriage return", async () => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });
    const smuggledOffer = OFFER_SDP.replace(
      "a=rtpmap:111 opus/48000/2",
      "a=rtpmap:111 opus/48000/2\rm=application 9 UDP/DTLS/SCTP webrtc-datachannel"
    );

    const response = await handler(request({ body: smuggledOffer }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty and non-UTF-8 SDP bodies", async () => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const empty = await handler(request({ body: null }));
    const invalidUtf8 = await handler(request({ body: new Uint8Array([0xc3, 0x28]) }));

    expect(empty.status).toBe(400);
    expect(invalidUtf8.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds both declared and streamed request bodies", async () => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const declaredTooLarge = await handler(request({
      headers: { "Content-Length": String(MAX_SDP_BYTES + 1) }
    }));
    const malformedLength = await handler(request({ headers: { "Content-Length": "NaN" } }));
    const streamedTooLarge = await handler(request({ body: "x".repeat(MAX_SDP_BYTES + 1) }));

    expect(declaredTooLarge.status).toBe(413);
    expect(malformedLength.status).toBe(413);
    expect(streamedTooLarge.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic no-store error when the server key is unavailable", async () => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment: { KB_FORM_ALLOWED_ORIGINS: APP_ORIGIN },
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe('{"error":"Realtime voice is temporarily unavailable."}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests when the process-local rate lease is unavailable", async () => {
    const fetchMock = successfulFetch();
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: { acquire: () => ({ allowed: false, retryAfterSeconds: 17 }) }
    });

    const response = await handler(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toEqual({ error: "Realtime voice is temporarily busy." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing Location", null],
    ["an external Location", `https://attacker.example/v1/realtime/calls/${CALL_ID}`],
    ["a Location with query data", `https://api.openai.com/v1/realtime/calls/${CALL_ID}?x=1`],
    ["a malformed call ID", "https://api.openai.com/v1/realtime/calls/not-a-call"]
  ])("rejects a successful upstream response with %s", async (_label, location) => {
    const fetchMock = successfulFetch({ location });
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request());

    expect(response.status).toBe(502);
    expect(response.headers.get(REALTIME_SESSION_TOKEN_HEADER)).toBeNull();
    expect(await response.text()).toBe('{"error":"Realtime voice is temporarily unavailable."}');
  });

  it.each([
    ["an invalid content type", successfulFetch({ contentType: "application/json" })],
    ["an invalid SDP answer", successfulFetch({ answer: "not sdp" })],
    ["a data-channel SDP answer", successfulFetch({ answer: ANSWER_SDP + DATA_CHANNEL_SECTION })],
    ["an oversized SDP answer", successfulFetch({ answer: "x".repeat(64 * 1_024 + 1) })],
    ["an upstream rejection", vi.fn(async () => new Response("secret upstream detail", { status: 401 }))]
  ])("fails closed on %s", async (_label, fetchMock) => {
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request());

    expect(response.status).toBe(502);
    const responseBody = await response.text();
    expect(responseBody).toBe('{"error":"Realtime voice is temporarily unavailable."}');
    expect(responseBody).not.toContain("secret");
    expect(responseBody).not.toContain("test-project-key");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects and cancels an oversized chunked upstream SDP before the stream ends", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1_024 + 1)));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/sdp",
        Location: `https://api.openai.com/v1/realtime/calls/${CALL_ID}`
      }
    }));
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request());

    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
  });

  it("rejects an upstream SDP answer containing a lone carriage return", async () => {
    const fetchMock = successfulFetch({
      answer: ANSWER_SDP.replace(
        "a=rtpmap:111 opus/48000/2",
        "a=rtpmap:111 opus/48000/2\ra=x:smuggled"
      )
    });
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const response = await handler(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Realtime voice is temporarily unavailable." });
  });

  it("releases its rate lease on both success and upstream failure", async () => {
    const releases = [vi.fn(), vi.fn()];
    let leaseIndex = 0;
    const rateLimiter = {
      acquire: vi.fn(() => ({ allowed: true as const, release: releases[leaseIndex++] }))
    };
    const fetchMock = successfulFetch();
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("network failure");
    });
    const handler = createRealtimeSessionHandler({ environment, fetch: fetchMock, rateLimiter });

    expect((await handler(request())).status).toBe(502);
    expect((await handler(request({ profile: "female-command" }))).status).toBe(200);

    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it("aborts an unresponsive upstream request after twelve seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })
    );
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const pendingResponse = handler(request());
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    const response = await pendingResponse;
    expect(response.status).toBe(504);
    expect(await response.text()).toBe('{"error":"Realtime voice is temporarily unavailable."}');
  });

  it("propagates browser cancellation to the upstream request without exposing details", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })
    );
    const handler = createRealtimeSessionHandler({
      environment,
      fetch: fetchMock,
      rateLimiter: createProcessLocalBestEffortRateLimiter()
    });

    const pendingResponse = handler(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    const response = await pendingResponse;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "Realtime voice is temporarily unavailable." });
  });
});

describe("process-local best-effort limiter", () => {
  it("reserves concurrent capacity atomically and releases it idempotently", () => {
    const limiter = createProcessLocalBestEffortRateLimiter({
      maxConcurrentRequests: 2,
      maxRequestsPerWindow: 4
    });

    const first = limiter.acquire("client");
    const second = limiter.acquire("client");
    const blocked = limiter.acquire("client");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 1 });

    if (first.allowed) {
      first.release();
      first.release();
    }
    expect(limiter.acquire("client").allowed).toBe(true);
  });

  it("enforces a request window and reopens it after expiry", () => {
    let now = 10_000;
    const limiter = createProcessLocalBestEffortRateLimiter({
      maxConcurrentRequests: 1,
      maxRequestsPerWindow: 1,
      windowMs: 5_000,
      now: () => now
    });

    const first = limiter.acquire("client");
    expect(first.allowed).toBe(true);
    if (first.allowed) {
      first.release();
    }
    expect(limiter.acquire("client")).toEqual({ allowed: false, retryAfterSeconds: 5 });

    now += 5_000;
    expect(limiter.acquire("client").allowed).toBe(true);
  });

  it("bounds tracked clients and evicts an idle entry", () => {
    const limiter = createProcessLocalBestEffortRateLimiter({ maxTrackedClients: 2 });
    const first = limiter.acquire("first");
    const second = limiter.acquire("second");
    if (first.allowed) first.release();
    if (second.allowed) second.release();

    expect(limiter.acquire("third").allowed).toBe(true);
  });
});
