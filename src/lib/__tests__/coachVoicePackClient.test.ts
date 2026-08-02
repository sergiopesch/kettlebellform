import { describe, expect, it, vi } from "vitest";
import { COACH_VOICE_ASSETS } from "../coachVoiceAssets";
import { createCoachVoicePackClient } from "../coachVoicePackClient";
import { coachVoiceMessage, type CoachVoiceMessageId } from "../coachVoicePolicy";
import type { VoiceProfileId } from "../coachVoiceProfiles";

type SourceStub = {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function audioHarness() {
  const sources: SourceStub[] = [];
  const gains: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    gain: {
      value: number;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
  }> = [];
  let state: AudioContextState = "suspended";
  const context = {
    currentTime: 1,
    destination: {},
    get state() {
      return state;
    },
    resume: vi.fn(async () => {
      state = "running";
    }),
    suspend: vi.fn(async () => {
      state = "suspended";
    }),
    close: vi.fn(async () => {
      state = "closed";
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 1 }) as AudioBuffer),
    createBufferSource: vi.fn(() => {
      const source: SourceStub = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    }),
    createGain: vi.fn(() => {
      const gain = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn()
        }
      };
      gains.push(gain);
      return gain as unknown as GainNode;
    })
  } as unknown as AudioContext;
  return { context, sources, gains };
}

function sameOriginTestAssets() {
  return Object.fromEntries(
    (Object.entries(COACH_VOICE_ASSETS) as Array<
      [VoiceProfileId, (typeof COACH_VOICE_ASSETS)[VoiceProfileId]]
    >).map(([profile, assets]) => [
      profile,
      Object.fromEntries(
        (Object.entries(assets) as Array<
          [CoachVoiceMessageId, (typeof assets)[CoachVoiceMessageId]]
        >).map(([cueId, asset]) => [
          cueId,
          {
            ...asset,
            url: `https://app.test/voice-assets/${profile}/${cueId}.mp3`
          }
        ])
      )
    ])
  ) as typeof COACH_VOICE_ASSETS;
}

function testAssetEntries(assets: typeof COACH_VOICE_ASSETS) {
  return (Object.entries(assets) as Array<
    [VoiceProfileId, (typeof assets)[VoiceProfileId]]
  >).flatMap(([profile, profileAssets], profileIndex) =>
    (Object.entries(profileAssets) as Array<
      [CoachVoiceMessageId, (typeof profileAssets)[CoachVoiceMessageId]]
    >).map(([cueId, asset], index) => ({
      profile,
      cueId,
      asset,
      marker: profileIndex * 11 + index + 1
    }))
  );
}

function streamingResponse(
  chunks: Uint8Array[],
  options: Readonly<{
    cancel?: (reason?: unknown) => void;
    close?: boolean;
    contentLength?: string;
  }> = {}
) {
  const headers = new Headers({ "content-type": "audio/mpeg" });
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel: options.cancel,
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        if (options.close !== false) {
          controller.close();
        }
      }
    }),
    { headers, status: 200 }
  );
}

function clientHarness(
  overrides: Partial<Parameters<typeof createCoachVoicePackClient>[0]> = {}
) {
  const audio = audioHarness();
  const assets = overrides.assets ?? sameOriginTestAssets();
  const entries = testAssetEntries(assets);
  const byUrl = new Map(
    entries.map((entry) => [new URL(entry.asset.url, "https://app.test/").href, entry])
  );
  const byMarker = new Map(entries.map((entry) => [entry.marker, entry]));
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const entry = byUrl.get(String(input));
    if (!entry) {
      return new Response(null, { status: 404 });
    }
    const contents = new Uint8Array(entry.asset.bytes);
    contents.fill(entry.marker);
    return new Response(contents, {
      status: 200,
      headers: { "content-type": "audio/mpeg" }
    });
  });
  const digestSha256 = vi.fn(async (contents: ArrayBuffer) => {
    const entry = byMarker.get(new Uint8Array(contents)[0]);
    if (!entry) {
      throw new Error("Unknown test asset.");
    }
    return entry.asset.sha256;
  });
  const onError = vi.fn();
  const client = createCoachVoicePackClient({
    baseUrl: "https://app.test/",
    createAudioContext: () => audio.context,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    digestSha256,
    onError,
    ...overrides,
    assets
  });
  return { client, audio, fetchImpl, digestSha256, onError };
}

describe("coach voice pack client", () => {
  it("does not allow callers to weaken fixed runtime deadlines", () => {
    expect(() => clientHarness({ assetLoadTimeoutMs: 15_001 })).toThrow(
      /timeout is invalid/i
    );
    expect(() => clientHarness({ activationTimeoutMs: 15_001 })).toThrow(
      /activation timeout is invalid/i
    );
    expect(() => clientHarness({ activationTimeoutMs: 0 })).toThrow(
      /activation timeout is invalid/i
    );
  });

  it("invokes resume synchronously but waits for it before loading the pack", async () => {
    const resumeGate = deferred<void>();
    const harness = clientHarness();
    vi.mocked(harness.audio.context.resume).mockReturnValueOnce(resumeGate.promise);

    const activation = harness.client.activate("male-command");

    expect(harness.audio.context.resume).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.digestSha256).not.toHaveBeenCalled();
    expect(harness.audio.context.decodeAudioData).not.toHaveBeenCalled();

    resumeGate.resolve(undefined);
    await activation;

    expect(harness.fetchImpl).toHaveBeenCalledTimes(11);
    expect(harness.audio.context.decodeAudioData).toHaveBeenCalledTimes(11);
  });

  it("times out a resume that never settles and circuit-breaks its context", async () => {
    const resumeGate = deferred<void>();
    const harness = clientHarness({ activationTimeoutMs: 30 });
    vi.mocked(harness.audio.context.resume).mockReturnValueOnce(resumeGate.promise);

    const activation = harness.client.activate("male-command");
    const rejection = expect(activation).rejects.toThrow(
      /activation timed out after 30 ms/i
    );

    expect(harness.audio.context.resume).toHaveBeenCalledOnce();
    await rejection;
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.audio.context.close).toHaveBeenCalledOnce();
    expect(harness.client.speak(coachVoiceMessage("ready"))).toBe(false);
    await expect(harness.client.activate("male-command")).rejects.toThrow(
      /unavailable after an activation failure/i
    );

    await harness.client.close();
    expect(harness.audio.context.close).toHaveBeenCalledOnce();
  });

  it("does no work before opt-in, then resumes and preloads the selected pack", async () => {
    const { client, audio, fetchImpl, digestSha256 } = clientHarness();

    expect(fetchImpl).not.toHaveBeenCalled();
    const activation = client.activate("male-command");
    expect(audio.context.resume).toHaveBeenCalledOnce();
    await activation;

    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(digestSha256).toHaveBeenCalledTimes(11);
    expect(audio.context.decodeAudioData).toHaveBeenCalledTimes(11);

    await client.activate("male-command");
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it("streams each legitimate asset up to its exact manifest size and releases every reader", async () => {
    const assets = sameOriginTestAssets();
    const entries = testAssetEntries(assets);
    const byUrl = new Map(entries.map((entry) => [entry.asset.url, entry]));
    const releasedReaders: Array<ReturnType<typeof vi.fn>> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const entry = byUrl.get(String(input));
      if (!entry) {
        return new Response(null, { status: 404 });
      }
      expect(init).toMatchObject({
        cache: "force-cache",
        credentials: "same-origin",
        redirect: "error"
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      const splitAt = Math.max(1, Math.floor(entry.asset.bytes / 2));
      const first = new Uint8Array(splitAt).fill(entry.marker);
      const second = new Uint8Array(entry.asset.bytes - splitAt).fill(entry.marker);
      const reads = [
        { done: false as const, value: first },
        { done: false as const, value: second },
        { done: true as const, value: undefined }
      ];
      const releaseLock = vi.fn();
      releasedReaders.push(releaseLock);
      const reader = {
        cancel: vi.fn(async () => undefined),
        read: vi.fn(async () => reads.shift() ?? reads[2]),
        releaseLock
      };
      return {
        body: { cancel: vi.fn(), getReader: () => reader },
        headers: new Headers({
          "content-length": String(entry.asset.bytes),
          "content-type": entry.asset.mimeType
        }),
        ok: true,
        status: 200
      } as unknown as Response;
    });
    const { client, audio, digestSha256 } = clientHarness({ assets, fetchImpl });

    await expect(client.activate("male-command")).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(digestSha256).toHaveBeenCalledTimes(11);
    expect(audio.context.decodeAudioData).toHaveBeenCalledTimes(11);
    expect(releasedReaders).toHaveLength(11);
    expect(releasedReaders.every((release) => release.mock.calls.length === 1)).toBe(
      true
    );
  });

  it("allows at most one underlying Web Audio decode at a time", async () => {
    const harness = clientHarness();
    let activeDecodes = 0;
    let maximumActiveDecodes = 0;
    vi.mocked(harness.audio.context.decodeAudioData).mockImplementation(async () => {
      activeDecodes += 1;
      maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { duration: 1 } as AudioBuffer;
      } finally {
        activeDecodes -= 1;
      }
    });

    await harness.client.activate("male-command");

    expect(harness.audio.context.decodeAudioData).toHaveBeenCalledTimes(11);
    expect(maximumActiveDecodes).toBe(1);
  });

  it("retains decode ownership across cancellation and rejects stale buffer writes", async () => {
    const harness = clientHarness();
    const firstDecode = deferred<AudioBuffer>();
    let decodeCalls = 0;
    let activeDecodes = 0;
    let maximumActiveDecodes = 0;
    vi.mocked(harness.audio.context.decodeAudioData).mockImplementation(() => {
      decodeCalls += 1;
      activeDecodes += 1;
      maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
      const operation =
        decodeCalls === 1
          ? firstDecode.promise
          : Promise.resolve({ duration: 1 } as AudioBuffer);
      return operation.finally(() => {
        activeDecodes -= 1;
      });
    });

    const firstActivation = harness.client.activate("male-command");
    await vi.waitFor(() =>
      expect(harness.audio.context.decodeAudioData).toHaveBeenCalledOnce()
    );
    harness.client.cancel();
    await expect(firstActivation).rejects.toMatchObject({ name: "AbortError" });

    const secondActivation = harness.client.activate("female-command");
    await vi.waitFor(() => expect(harness.fetchImpl).toHaveBeenCalledTimes(22));
    expect(harness.audio.context.decodeAudioData).toHaveBeenCalledOnce();

    firstDecode.resolve({ duration: 1 } as AudioBuffer);
    await secondActivation;
    expect(maximumActiveDecodes).toBe(1);
    expect(harness.client.speak(coachVoiceMessage("female-command-selected"))).toBe(
      true
    );

    // The decoded result from the canceled male activation must not enter the
    // cache; a later male activation still verifies and loads all 11 assets.
    await harness.client.activate("male-command");
    expect(harness.fetchImpl).toHaveBeenCalledTimes(33);
    expect(maximumActiveDecodes).toBe(1);
  });

  it("times out a decoder that never settles without releasing its ownership", async () => {
    const decodeGate = deferred<AudioBuffer>();
    const harness = clientHarness({ activationTimeoutMs: 100 });
    vi.mocked(harness.audio.context.decodeAudioData).mockReturnValueOnce(
      decodeGate.promise
    );

    const activation = harness.client.activate("female-command");
    const rejection = expect(activation).rejects.toThrow(
      /activation timed out after 100 ms/i
    );
    await vi.waitFor(() =>
      expect(harness.audio.context.decodeAudioData).toHaveBeenCalledOnce()
    );
    await rejection;

    expect(harness.audio.context.close).toHaveBeenCalledOnce();
    expect(harness.client.speak(coachVoiceMessage("ready"))).toBe(false);
    decodeGate.resolve({ duration: 1 } as AudioBuffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.audio.context.decodeAudioData).toHaveBeenCalledOnce();
    await expect(harness.client.activate("female-command")).rejects.toThrow(
      /unavailable after an activation failure/i
    );
  });

  it("plays only allowlisted messages and replaces owned audio cleanly", async () => {
    const { client, audio } = clientHarness();
    await client.activate("male-command");

    expect(client.speak(coachVoiceMessage("move-left"))).toBe(true);
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].start).toHaveBeenCalledOnce();

    expect(client.speak(coachVoiceMessage("move-right"))).toBe(true);
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[0].stop).toHaveBeenCalledWith(1.02);
    expect(audio.sources[0].disconnect).not.toHaveBeenCalled();
    expect(audio.gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 1.02);
    audio.sources[0].onended?.();
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.gains[0].disconnect).toHaveBeenCalledOnce();

    expect(
      client.speak({ id: "move-left", speech: "Move now." } as never)
    ).toBe(false);
  });

  it("invalidates stale activation when a newer profile wins", async () => {
    const { client, fetchImpl } = clientHarness();
    const first = client.activate("male-command");
    const second = client.activate("female-command");

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await second;
    // The superseded activation never starts loading because its resume did
    // not win the activation race.
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(client.speak(coachVoiceMessage("female-command-selected"))).toBe(true);
  });

  it("rejects cross-origin assets before playback", async () => {
    const safeAssets = sameOriginTestAssets();
    const unsafeAssets = {
      ...safeAssets,
      "male-command": {
        ...safeAssets["male-command"],
        finding: {
          ...safeAssets["male-command"].finding,
          url: "https://attacker.example/finding.mp3"
        }
      }
    } as typeof COACH_VOICE_ASSETS;
    const { client } = clientHarness({ assets: unsafeAssets });

    await expect(client.activate("male-command")).rejects.toThrow(/same-origin/i);
  });

  it("fails closed on MIME, size, or hash mismatch", async () => {
    const mimeHarness = clientHarness({
      fetchImpl: vi.fn(async () =>
        new Response(new Uint8Array(1), {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        })
      ) as unknown as typeof fetch
    });
    await expect(mimeHarness.client.activate("male-command")).rejects.toThrow(
      /media type/i
    );

    const sizeHarness = clientHarness({
      fetchImpl: vi.fn(async () =>
        new Response(new Uint8Array(1), {
          status: 200,
          headers: { "content-type": "audio/mpeg" }
        })
      ) as unknown as typeof fetch
    });
    await expect(sizeHarness.client.activate("male-command")).rejects.toThrow(
      /size check/i
    );

    const hashHarness = clientHarness({
      digestSha256: vi.fn(async () => "0".repeat(64))
    });
    await expect(hashHarness.client.activate("male-command")).rejects.toThrow(
      /integrity/i
    );
  });

  it("rejects an oversized declared length before acquiring a body reader", async () => {
    const getReader = vi.fn();
    const cancelBody = vi.fn(async () => undefined);
    const assets = sameOriginTestAssets();
    const byUrl = new Map(
      testAssetEntries(assets).map((entry) => [entry.asset.url, entry])
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const entry = byUrl.get(String(input));
      if (!entry) {
        return new Response(null, { status: 404 });
      }
      return {
        body: { cancel: cancelBody, getReader },
        headers: new Headers({
          "content-length": String(entry.asset.bytes + 1),
          "content-type": entry.asset.mimeType
        }),
        ok: true,
        status: 200
      } as unknown as Response;
    });
    const { client, audio, digestSha256 } = clientHarness({ assets, fetchImpl });

    await expect(client.activate("male-command")).rejects.toThrow(/size check/i);

    expect(getReader).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalled();
    expect(digestSha256).not.toHaveBeenCalled();
    expect(audio.context.decodeAudioData).not.toHaveBeenCalled();
  });

  it.each([
    ["an absent", undefined],
    ["a misleadingly small", "1"]
  ])(
    "enforces the actual manifest-byte ceiling with %s Content-Length",
    async (_label, contentLength) => {
      const assets = sameOriginTestAssets();
      const byUrl = new Map(
        testAssetEntries(assets).map((entry) => [entry.asset.url, entry])
      );
      const cancelled = vi.fn();
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const entry = byUrl.get(String(input));
        if (!entry) {
          return new Response(null, { status: 404 });
        }
        return streamingResponse(
          [
            new Uint8Array(entry.asset.bytes).fill(entry.marker),
            new Uint8Array([entry.marker])
          ],
          { cancel: cancelled, close: false, contentLength }
        );
      });
      const { client, audio, digestSha256 } = clientHarness({ assets, fetchImpl });

      await expect(client.activate("male-command")).rejects.toThrow(/size check/i);

      expect(cancelled).toHaveBeenCalled();
      expect(digestSha256).not.toHaveBeenCalled();
      expect(audio.context.decodeAudioData).not.toHaveBeenCalled();
    }
  );

  it("times out and cancels a response body that stops making progress", async () => {
    const assets = sameOriginTestAssets();
    const byUrl = new Map(
      testAssetEntries(assets).map((entry) => [entry.asset.url, entry])
    );
    const stalledCancellation = vi.fn();
    const stalledSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const entry = byUrl.get(String(input));
        if (!entry) {
          return new Response(null, { status: 404 });
        }
        if (entry.cueId === "finding") {
          if (init?.signal) {
            stalledSignals.push(init.signal);
          }
          return streamingResponse(
            [new Uint8Array([entry.marker])],
            { cancel: stalledCancellation, close: false }
          );
        }
        return streamingResponse(
          [new Uint8Array(entry.asset.bytes).fill(entry.marker)],
          { contentLength: String(entry.asset.bytes) }
        );
      }
    );
    const { client } = clientHarness({
      assetLoadTimeoutMs: 30,
      assets,
      fetchImpl
    });

    await expect(client.activate("male-command")).rejects.toThrow(
      /timed out after 30 ms/i
    );

    expect(stalledCancellation).toHaveBeenCalledOnce();
    expect(stalledSignals).toHaveLength(1);
    expect(stalledSignals[0].aborted).toBe(true);
  });

  it("composes caller cancellation with an in-progress response read", async () => {
    const assets = sameOriginTestAssets();
    const byUrl = new Map(
      testAssetEntries(assets).map((entry) => [entry.asset.url, entry])
    );
    const stalledCancellation = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const entry = byUrl.get(String(input));
      if (!entry) {
        return new Response(null, { status: 404 });
      }
      if (entry.cueId === "finding") {
        return streamingResponse([], {
          cancel: stalledCancellation,
          close: false
        });
      }
      return streamingResponse(
        [new Uint8Array(entry.asset.bytes).fill(entry.marker)],
        { contentLength: String(entry.asset.bytes) }
      );
    });
    const { client } = clientHarness({ assets, fetchImpl });
    const activation = client.activate("male-command");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(11));

    client.cancel();

    await expect(activation).rejects.toMatchObject({ name: "AbortError" });
    expect(stalledCancellation).toHaveBeenCalledOnce();
  });

  it("fails closed when Web Audio cannot resume or decode", async () => {
    const resumeHarness = clientHarness();
    vi.mocked(resumeHarness.audio.context.resume).mockRejectedValueOnce(
      new Error("resume failed")
    );
    await expect(resumeHarness.client.activate("male-command")).rejects.toThrow(
      /resume failed/i
    );

    const decodeHarness = clientHarness();
    vi.mocked(decodeHarness.audio.context.decodeAudioData).mockRejectedValue(
      new Error("decode failed")
    );
    await expect(decodeHarness.client.activate("female-command")).rejects.toThrow(
      /decode failed/i
    );
  });

  it("aborts stale activation requests and suspends while inactive", async () => {
    const requestSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          requestSignals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const abortHarness = clientHarness({
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const activation = abortHarness.client.activate("male-command");
    await vi.waitFor(() => expect(requestSignals).toHaveLength(11));
    abortHarness.client.cancel();
    await expect(activation).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignals).toHaveLength(11);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);

    const suspendHarness = clientHarness();
    await suspendHarness.client.activate("female-command");
    expect(suspendHarness.client.speak(coachVoiceMessage("ready"))).toBe(true);
    const deactivation = suspendHarness.client.deactivate();
    expect(suspendHarness.audio.sources[0].stop).toHaveBeenCalledWith(1.02);
    expect(suspendHarness.audio.context.suspend).not.toHaveBeenCalled();
    await deactivation;
    expect(suspendHarness.audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(suspendHarness.audio.context.suspend).toHaveBeenCalledOnce();
    expect(suspendHarness.client.speak(coachVoiceMessage("ready"))).toBe(false);
    await suspendHarness.client.activate("female-command");
    expect(suspendHarness.audio.context.resume).toHaveBeenCalledTimes(2);
    expect(suspendHarness.fetchImpl).toHaveBeenCalledTimes(11);
  });

  it("cancels immediately and closes its one owned audio context", async () => {
    const { client, audio } = clientHarness();
    await client.activate("female-command");
    expect(client.speak(coachVoiceMessage("ready"))).toBe(true);

    client.cancel();
    expect(audio.sources[0].stop).toHaveBeenCalledOnce();
    await client.close();
    expect(audio.context.close).toHaveBeenCalledOnce();
    expect(client.speak(coachVoiceMessage("ready"))).toBe(false);
    await expect(client.activate("female-command")).rejects.toThrow(/closed/i);
  });
});
