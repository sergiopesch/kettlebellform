import {
  COACH_VOICE_ASSETS,
  type CoachVoiceAsset
} from "./coachVoiceAssets";
import {
  COACH_VOICE_MESSAGES,
  isCoachVoiceMessage,
  type CoachVoiceMessage,
  type CoachVoiceMessageId
} from "./coachVoicePolicy";
import type { VoiceProfileId } from "./coachVoiceProfiles";

export type CoachVoicePackClient = Readonly<{
  activate: (profile: VoiceProfileId) => Promise<void>;
  speak: (message: CoachVoiceMessage) => boolean;
  cancel: () => void;
  deactivate: () => Promise<void>;
  close: () => Promise<void>;
}>;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type CoachVoicePackClientOptions = Readonly<{
  onError?: (message: string) => void;
  assets?: typeof COACH_VOICE_ASSETS;
  fetchImpl?: typeof fetch;
  createAudioContext?: () => AudioContext;
  digestSha256?: (contents: ArrayBuffer) => Promise<string>;
  baseUrl?: string;
  assetLoadTimeoutMs?: number;
}>;

const MESSAGE_IDS = Object.freeze(
  Object.keys(COACH_VOICE_MESSAGES) as CoachVoiceMessageId[]
);
const CANCEL_FADE_SECONDS = 0.02;
const CANCEL_SETTLE_MS = 30;
const ASSET_LOAD_TIMEOUT_MS = 15_000;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext
  );
}

function defaultCreateAudioContext() {
  const AudioContextClass = getAudioContextConstructor();
  if (!AudioContextClass) {
    throw new Error("Web Audio is unavailable.");
  }
  return new AudioContextClass({ latencyHint: "interactive" });
}

async function defaultDigestSha256(contents: ArrayBuffer) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", contents);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function supportsCoachVoicePack() {
  return (
    typeof window !== "undefined" &&
    typeof window.fetch === "function" &&
    getAudioContextConstructor() !== undefined &&
    globalThis.crypto?.subtle !== undefined
  );
}

function canceledActivation() {
  return new DOMException("Voice pack activation was superseded.", "AbortError");
}

function assetLoadTimeout(timeoutMs: number) {
  return new Error(`A branded voice asset timed out after ${timeoutMs} ms.`);
}

function abortReason(signal: AbortSignal, fallback: Error) {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

async function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    throw abortReason(signal, canceledActivation());
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal, canceledActivation()));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function validateDeclaredAssetLength(response: Response, maximumBytes: number) {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null) {
    return;
  }
  const normalized = rawLength.trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    throw new Error("A branded voice asset failed its size check.");
  }
  const length = Number(normalized);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new Error("A branded voice asset failed its size check.");
  }
}

function cancelResponseBody(
  body: ReadableStream<Uint8Array> | null,
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
  reason: unknown
) {
  try {
    const cancellation = reader ? reader.cancel(reason) : body?.cancel(reason);
    void cancellation?.catch(() => undefined);
  } catch {
    // The fetch signal is already aborted; cancellation here is best-effort cleanup.
  }
}

export function createCoachVoicePackClient(
  options: CoachVoicePackClientOptions = {}
): CoachVoicePackClient {
  const assets = options.assets ?? COACH_VOICE_ASSETS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const createAudioContext = options.createAudioContext ?? defaultCreateAudioContext;
  const digestSha256 = options.digestSha256 ?? defaultDigestSha256;
  const baseUrl = options.baseUrl ?? globalThis.location?.href ?? "http://localhost/";
  const assetLoadTimeoutMs = options.assetLoadTimeoutMs ?? ASSET_LOAD_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(assetLoadTimeoutMs) ||
    assetLoadTimeoutMs <= 0 ||
    assetLoadTimeoutMs > ASSET_LOAD_TIMEOUT_MS
  ) {
    throw new Error("The branded voice asset timeout is invalid.");
  }
  const buffers = new Map<string, AudioBuffer>();
  let context: AudioContext | null = null;
  let activeSource: AudioBufferSourceNode | null = null;
  let activeGain: GainNode | null = null;
  let activationAbort: AbortController | null = null;
  let selectedProfile: VoiceProfileId | null = null;
  let generation = 0;
  let closed = false;

  const assetKey = (profile: VoiceProfileId, cueId: CoachVoiceMessageId) =>
    `${profile}/${cueId}`;

  const ensureSameOriginUrl = (asset: CoachVoiceAsset) => {
    const url = new URL(asset.url, baseUrl);
    const origin = new URL(baseUrl).origin;
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.protocol !== new URL(baseUrl).protocol
    ) {
      throw new Error("Voice assets must use a same-origin URL.");
    }
    return url.href;
  };

  const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) {
      throw canceledActivation();
    }
  };

  const fetchAssetContents = async (
    asset: CoachVoiceAsset,
    url: string,
    activationSignal: AbortSignal
  ) => {
    const requestController = new AbortController();
    const onActivationAbort = () => requestController.abort(canceledActivation());
    activationSignal.addEventListener("abort", onActivationAbort, { once: true });
    if (activationSignal.aborted) {
      onActivationAbort();
    }

    const timeoutError = assetLoadTimeout(assetLoadTimeoutMs);
    const timeoutHandle = setTimeout(
      () => requestController.abort(timeoutError),
      assetLoadTimeoutMs
    );
    let body: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = await waitWithSignal(
        Promise.resolve().then(() =>
          fetchImpl(url, {
            cache: "force-cache",
            credentials: "same-origin",
            redirect: "error",
            signal: requestController.signal
          })
        ),
        requestController.signal
      );
      throwIfAborted(activationSignal);
      body = response.body;
      if (!response.ok) {
        throw new Error("A branded voice asset could not be loaded.");
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim();
      if (contentType !== asset.mimeType) {
        throw new Error("A branded voice asset had an unexpected media type.");
      }
      if (!body) {
        throw new Error("A branded voice asset could not be loaded.");
      }
      validateDeclaredAssetLength(response, asset.bytes);

      reader = body.getReader();
      const contents = new Uint8Array(asset.bytes);
      let receivedBytes = 0;
      while (true) {
        const { done, value } = await waitWithSignal(
          reader.read(),
          requestController.signal
        );
        if (done) {
          break;
        }
        if (!ArrayBuffer.isView(value) || value.BYTES_PER_ELEMENT !== 1) {
          throw new Error("A branded voice asset could not be loaded.");
        }
        if (value.byteLength > asset.bytes - receivedBytes) {
          throw new Error("A branded voice asset failed its size check.");
        }
        contents.set(value, receivedBytes);
        receivedBytes += value.byteLength;
      }
      throwIfAborted(activationSignal);
      if (receivedBytes !== asset.bytes) {
        throw new Error("A branded voice asset failed its size check.");
      }
      return contents.buffer;
    } catch (error) {
      const failure = activationSignal.aborted
        ? canceledActivation()
        : requestController.signal.aborted
          ? abortReason(requestController.signal, timeoutError)
          : error;
      if (!requestController.signal.aborted) {
        requestController.abort(failure);
      }
      cancelResponseBody(body, reader, failure);
      throw failure;
    } finally {
      clearTimeout(timeoutHandle);
      activationSignal.removeEventListener("abort", onActivationAbort);
      try {
        reader?.releaseLock();
      } catch {
        // A hostile stream may retain its pending read after cancellation.
      }
    }
  };

  const loadBuffer = async (
    profile: VoiceProfileId,
    cueId: CoachVoiceMessageId,
    signal: AbortSignal
  ) => {
    const key = assetKey(profile, cueId);
    const cached = buffers.get(key);
    if (cached) {
      return cached;
    }
    const asset = assets[profile][cueId];
    throwIfAborted(signal);
    const url = ensureSameOriginUrl(asset);
    const contents = await fetchAssetContents(asset, url, signal);
    const receivedHash = await digestSha256(contents.slice(0));
    throwIfAborted(signal);
    if (receivedHash !== asset.sha256) {
      throw new Error("A branded voice asset failed its integrity check.");
    }
    if (!context || closed) {
      throw canceledActivation();
    }
    const decoded = await context.decodeAudioData(contents.slice(0));
    throwIfAborted(signal);
    buffers.set(key, decoded);
    return decoded;
  };

  const stopActiveSource = () => {
    const source = activeSource;
    const gain = activeGain;
    activeSource = null;
    activeGain = null;
    if (!source) {
      return null;
    }
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      source.onended = null;
      try {
        source.disconnect();
        gain?.disconnect();
      } catch {
        // Some Web Audio implementations throw after an ended node disconnects.
      }
    };
    source.onended = disconnect;
    try {
      if (context && gain) {
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + CANCEL_FADE_SECONDS);
        source.stop(now + CANCEL_FADE_SECONDS);
      } else {
        source.stop();
      }
    } catch {
      // The source may already have ended, so release the graph immediately.
      disconnect();
    }
    return disconnect;
  };

  const cancelInternal = () => {
    generation += 1;
    activationAbort?.abort();
    activationAbort = null;
    return stopActiveSource();
  };

  const cancel = () => {
    cancelInternal();
  };

  const activate = async (profile: VoiceProfileId) => {
    if (closed) {
      throw new Error("Voice pack client is closed.");
    }
    cancel();
    const activationGeneration = generation;
    const controller = new AbortController();
    activationAbort = controller;
    selectedProfile = null;
    context ??= createAudioContext();

    // Resume synchronously from the opt-in handler before the first await so
    // Safari retains the user's transient audio activation.
    const resume = context.state === "running" ? Promise.resolve() : context.resume();
    const preload = Promise.all(
      MESSAGE_IDS.map((cueId) => loadBuffer(profile, cueId, controller.signal))
    );
    try {
      await Promise.all([resume, preload]);
      if (closed || generation !== activationGeneration || controller.signal.aborted) {
        throw canceledActivation();
      }
      selectedProfile = profile;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      if (activationAbort === controller) {
        activationAbort = null;
      }
    }
  };

  const speak = (message: CoachVoiceMessage) => {
    if (
      closed ||
      !context ||
      context.state !== "running" ||
      !selectedProfile ||
      !isCoachVoiceMessage(message)
    ) {
      return false;
    }
    const buffer = buffers.get(assetKey(selectedProfile, message.id));
    if (!buffer) {
      return false;
    }
    cancel();
    const playbackGeneration = generation;
    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(context.destination);
      activeSource = source;
      activeGain = gain;
      source.onended = () => {
        if (
          generation === playbackGeneration &&
          activeSource === source &&
          activeGain === gain
        ) {
          activeSource = null;
          activeGain = null;
          source.disconnect();
          gain.disconnect();
        }
      };
      source.start();
      return true;
    } catch {
      stopActiveSource();
      options.onError?.(
        "The branded voice could not play. Visual framing cues remain active."
      );
      return false;
    }
  };

  const deactivate = async () => {
    selectedProfile = null;
    const finishDisconnect = cancelInternal();
    const ownedContext = context;
    if (finishDisconnect && ownedContext?.state === "running") {
      await new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS));
      finishDisconnect();
    }
    if (ownedContext?.state === "running") {
      await ownedContext.suspend().catch(() => undefined);
    }
  };

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    selectedProfile = null;
    cancel();
    buffers.clear();
    const ownedContext = context;
    context = null;
    if (ownedContext && ownedContext.state !== "closed") {
      await ownedContext.close().catch(() => undefined);
    }
  };

  return Object.freeze({ activate, speak, cancel, deactivate, close });
}
