import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnatomyLayerState, CoachSettings } from "../../types";
import type { PoseWorkerFrameRequest, PoseWorkerResponse } from "../../workers/poseProtocol";
import { usePoseCoach, type ClipAnalysisOptions } from "../usePoseCoach";

const settings: CoachSettings = {
  heightCm: 178,
  bellKg: 16,
  experience: "trained",
  goal: "technique",
  sideView: true
};

const layers: AnatomyLayerState = {
  body: true,
  muscles: false,
  skeleton: true,
  gaussian: false
};

type SentMessage = {
  message: { type: string } | PoseWorkerFrameRequest;
  transfer?: Transferable[];
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class WorkerStub {
  static instances: WorkerStub[] = [];

  onmessage: ((event: MessageEvent<PoseWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: SentMessage[] = [];
  terminate = vi.fn();
  throwOnNextFrame: Error | null = null;

  constructor() {
    WorkerStub.instances.push(this);
  }

  postMessage(message: { type: string } | PoseWorkerFrameRequest, transfer?: Transferable[]) {
    if (message.type === "frame" && this.throwOnNextFrame) {
      const error = this.throwOnNextFrame;
      this.throwOnNextFrame = null;
      throw error;
    }
    this.sent.push({ message, transfer });
  }

  emitReady(delegate: "GPU" | "CPU" = "GPU") {
    this.onmessage?.(
      new MessageEvent("message", {
        data: { type: "ready", delegate, version: "test" } satisfies PoseWorkerResponse
      })
    );
  }

  emitResult(
    request: PoseWorkerFrameRequest,
    result: {
      poseCount?: number;
      landmarks?: NormalizedLandmark[] | null;
      worldLandmarks?: Landmark[] | null;
    } = {}
  ) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "result",
          channel: request.channel,
          jobId: request.jobId,
          frameId: request.frameId,
          engineTimestamp: request.engineTimestamp,
          sourceTimestamp: request.sourceTimestamp,
          inferenceMs: 4,
          poseCount: result.poseCount ?? 0,
          landmarks: result.landmarks ?? null,
          worldLandmarks: result.worldLandmarks ?? null
        } satisfies PoseWorkerResponse
      })
    );
  }

  get frameRequests(): PoseWorkerFrameRequest[] {
    return this.sent
      .map((entry) => entry.message)
      .filter((message): message is PoseWorkerFrameRequest => message.type === "frame");
  }
}

let nextVideoFrameHandle = 1;
let pendingVideoFrames = new Map<number, VideoFrameRequestCallback>();
let requestVideoFrameCallbackMock: ReturnType<typeof vi.fn>;
let cancelVideoFrameCallbackMock: ReturnType<typeof vi.fn>;
let createImageBitmapMock: ReturnType<typeof vi.fn>;
let createdBitmapCloseMocks: Array<ReturnType<typeof vi.fn>>;
let originalMediaDevices: PropertyDescriptor | undefined;

function makeVideo({ width = 1920, height = 1080, duration = 10, currentTime = 0 } = {}): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
    duration: { configurable: true, value: duration },
    ended: { configurable: true, value: false }
  });
  video.currentTime = currentTime;
  video.playbackRate = 1;
  return video;
}

function options(
  video: HTMLVideoElement,
  overrides: Partial<Omit<ClipAnalysisOptions, "video">> = {}
): ClipAnalysisOptions {
  return {
    video,
    startTime: 0,
    endTime: 4,
    crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.8 },
    output: { width: 640, height: 576 },
    onProgress: vi.fn(),
    ...overrides
  };
}

function makeFinitePose(): {
  landmarks: NormalizedLandmark[];
  worldLandmarks: Landmark[];
} {
  const landmarks: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 1
  }));
  const worldLandmarks: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1
  }));

  // A deliberately wide shoulder-to-height ratio makes sideView observable:
  // sideView=true produces cameraQuality 0.28; false produces 1.
  landmarks[7] = { x: 0.49, y: 0.1, z: 0, visibility: 1 };
  landmarks[8] = { x: 0.51, y: 0.1, z: 0, visibility: 1 };
  landmarks[11] = { x: 0.25, y: 0.25, z: 0, visibility: 1 };
  landmarks[12] = { x: 0.75, y: 0.25, z: 0, visibility: 1 };
  landmarks[23] = { x: 0.49, y: 0.55, z: 0, visibility: 1 };
  landmarks[24] = { x: 0.51, y: 0.55, z: 0, visibility: 1 };
  landmarks[27] = { x: 0.49, y: 0.9, z: 0, visibility: 1 };
  landmarks[28] = { x: 0.51, y: 0.9, z: 0, visibility: 1 };

  return { landmarks, worldLandmarks };
}

function latestWorker(): WorkerStub {
  const worker = WorkerStub.instances.at(-1);
  if (!worker) {
    throw new Error("Expected the pose hook to create a Worker.");
  }
  return worker;
}

async function makeModelReady(
  result: { result: { current: ReturnType<typeof usePoseCoach> } },
  delegate: "GPU" | "CPU" = "GPU"
) {
  await act(async () => latestWorker().emitReady(delegate));
  await waitFor(() => expect(result.result.current.modelStatus).toBe("ready"));
}

async function fireNextVideoFrame(mediaTimeSeconds: number) {
  const next = pendingVideoFrames.entries().next().value as
    | [number, VideoFrameRequestCallback]
    | undefined;
  if (!next) {
    throw new Error("Expected a pending video-frame callback.");
  }
  const [handle, callback] = next;
  pendingVideoFrames.delete(handle);
  await act(async () => {
    callback(500, { mediaTime: mediaTimeSeconds } as VideoFrameCallbackMetadata);
    await Promise.resolve();
  });
}

async function endVideo(video: HTMLVideoElement) {
  video.currentTime = video.duration;
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  await act(async () => {
    video.dispatchEvent(new Event("ended"));
    await Promise.resolve();
  });
}

async function failVideoDecode(video: HTMLVideoElement) {
  Object.defineProperty(video, "error", {
    configurable: true,
    value: {
      code: 3,
      message: "The media resource could not be decoded."
    } satisfies Pick<MediaError, "code" | "message">
  });
  await act(async () => {
    video.dispatchEvent(new Event("error"));
    await Promise.resolve();
  });
}

async function emitResult(
  worker: WorkerStub,
  request: PoseWorkerFrameRequest,
  result: Parameters<WorkerStub["emitResult"]>[1] = {}
) {
  await act(async () => {
    worker.emitResult(request, result);
    await Promise.resolve();
  });
}

async function flushMicrotasks(iterations = 8) {
  await act(async () => {
    for (let index = 0; index < iterations; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("usePoseCoach clip analysis protocol", () => {
  beforeEach(() => {
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    WorkerStub.instances = [];
    pendingVideoFrames = new Map();
    nextVideoFrameHandle = 1;
    createdBitmapCloseMocks = [];

    requestVideoFrameCallbackMock = vi.fn((callback: VideoFrameRequestCallback) => {
      const handle = nextVideoFrameHandle;
      nextVideoFrameHandle += 1;
      pendingVideoFrames.set(handle, callback);
      return handle;
    });
    cancelVideoFrameCallbackMock = vi.fn((handle: number) => {
      pendingVideoFrames.delete(handle);
    });
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: {
        configurable: true,
        value: requestVideoFrameCallbackMock
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: cancelVideoFrameCallbackMock
      }
    });

    createImageBitmapMock = vi.fn(async () => {
      const close = vi.fn();
      createdBitmapCloseMocks.push(close);
      return { close } as unknown as ImageBitmap;
    });
    vi.stubGlobal("Worker", WorkerStub);
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(performance, "now").mockReturnValue(100);
  });

  afterEach(() => {
    cleanup();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects clip analysis while the model is not ready", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));

    await expect(hook.result.current.analyzeClip(options(makeVideo()))).rejects.toThrow(
      "The on-device pose model is not ready yet."
    );
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(latestWorker().frameRequests).toHaveLength(0);
  });

  it("rejects undersized windows and caller-supplied oversized inference dimensions", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const video = makeVideo();

    await expect(
      hook.result.current.analyzeClip(options(video, { endTime: 1 }))
    ).rejects.toThrow(/4 to 10 seconds/i);
    await expect(
      hook.result.current.analyzeClip(options(video, { output: { width: 6_400, height: 5_760 } }))
    ).rejects.toThrow(/unsafe output dimensions/i);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("emits cropped, downscaled clip envelopes with monotonic engine and media timestamps", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo();
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));

    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    const first = worker.frameRequests[0];

    expect(createImageBitmapMock).toHaveBeenNthCalledWith(
      1,
      video,
      480,
      108,
      960,
      864,
      { resizeWidth: 640, resizeHeight: 576, resizeQuality: "medium" }
    );
    expect(first).toMatchObject({
      type: "frame",
      channel: "clip",
      jobId: 1,
      frameId: 0,
      sourceTimestamp: 100
    });
    expect(Number.isFinite(first.engineTimestamp)).toBe(true);
    expect(worker.sent.find((entry) => entry.message === first)?.transfer).toEqual([first.frame]);

    await emitResult(worker, first);
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    await fireNextVideoFrame(0.2);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(2));
    const second = worker.frameRequests[1];

    expect(second).toMatchObject({
      type: "frame",
      channel: "clip",
      jobId: 1,
      frameId: 1,
      sourceTimestamp: 200
    });
    expect(second.engineTimestamp).toBeGreaterThan(first.engineTimestamp);
    expect(second.sourceTimestamp).toBeGreaterThan(first.sourceTimestamp);

    await emitResult(worker, second);
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(3));
    await fireNextVideoFrame(4);
    await expect(analysisPromise).resolves.toMatchObject({ processedFrames: 2, expectedFrames: 60 });
  });

  it("keeps one frame in flight and schedules no pending queue", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(makeVideo()));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));

    await Promise.resolve();
    expect(worker.frameRequests).toHaveLength(1);
    expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1);
    expect(pendingVideoFrames).toHaveLength(0);

    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    expect(pendingVideoFrames).toHaveLength(1);

    await fireNextVideoFrame(4);
    await expect(analysisPromise).resolves.toMatchObject({ processedFrames: 1 });
  });

  it("pauses source time while Worker backpressure keeps only one frame in flight", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo();
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);

    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    expect(pause).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledTimes(1);
    expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1);

    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    expect(play).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(2);

    await fireNextVideoFrame(4);
    await expect(analysisPromise).resolves.toMatchObject({ processedFrames: 1 });
    expect(play).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(3);
  });

  it("does not accept a currentTime jump as proof that the selected endpoint decoded", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
      void analysisPromise.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        }
      );
    });
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    await fireNextVideoFrame(1.8);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    video.currentTime = video.duration;
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    expect(outcome).toBe("pending");

    await endVideo(video);

    await expect(analysisPromise).rejects.toThrow(/ended before.*window|damaged|incomplete/i);
    expect(outcome).toBe("rejected");
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("rejects a currentTime endpoint jump in the animation-frame fallback", async () => {
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    let pendingAnimationFrame: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        pendingAnimationFrame = callback;
        return 1;
      })
    );
    const fireAnimationFrame = async () => {
      const callback = pendingAnimationFrame;
      if (!callback) {
        throw new Error("Expected a pending animation-frame callback.");
      }
      pendingAnimationFrame = null;
      await act(async () => {
        callback(500);
        await Promise.resolve();
      });
    };

    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
    });
    const rejection = expect(analysisPromise).rejects.toThrow(/skipped too far|damaged|interrupted/i);
    await waitFor(() => expect(pendingAnimationFrame).not.toBeNull());

    video.currentTime = 0.1;
    await fireAnimationFrame();
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(pendingAnimationFrame).not.toBeNull());

    video.currentTime = video.duration;
    await fireAnimationFrame();

    await rejection;
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("finishes the animation-frame fallback from a recent processed frame", async () => {
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    let pendingAnimationFrame: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        pendingAnimationFrame = callback;
        return 1;
      })
    );
    const fireAnimationFrame = async () => {
      const callback = pendingAnimationFrame;
      if (!callback) {
        throw new Error("Expected a pending animation-frame callback.");
      }
      pendingAnimationFrame = null;
      await act(async () => {
        callback(500);
        await Promise.resolve();
      });
    };

    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(pendingAnimationFrame).not.toBeNull());

    video.currentTime = 3.8;
    await fireAnimationFrame();
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(pendingAnimationFrame).not.toBeNull());

    video.currentTime = video.duration;
    await fireAnimationFrame();

    await expect(analysisPromise).resolves.toMatchObject({ processedFrames: 1 });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("rejects an endpoint callback when no frame was processed", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(makeVideo({ duration: 4 })));
    });
    const rejection = expect(analysisPromise).rejects.toThrow(/no decodable video frames/i);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(4);

    await rejection;
    expect(hook.result.current.clipBusy).toBe(false);
  });

  it("finishes when media ends after its final decoded frame falls just before endTime", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    // Real containers can report a duration a few milliseconds beyond the last
    // decoded frame. The Wikimedia VP8 fixture has this exact shape.
    await fireNextVideoFrame(3.916);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    await endVideo(video);

    await expect(analysisPromise).resolves.toMatchObject({
      processedFrames: 1,
      expectedFrames: 60
    });
    expect(pendingVideoFrames).toHaveLength(0);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("drains the final transferred frame before settling an ended event", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
      void analysisPromise.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        }
      );
    });
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(3.916);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));

    await endVideo(video);
    await flushMicrotasks();

    expect(outcome).toBe("pending");
    expect(hook.result.current.clipBusy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    await emitResult(worker, worker.frameRequests[0]);

    await expect(analysisPromise).resolves.toMatchObject({ processedFrames: 1 });
    expect(outcome).toBe("resolved");
    expect(hook.result.current.clipBusy).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("rejects a truncated source using the last presented frame even when Chrome reports duration at ended", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let truncatedRun!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      truncatedRun = hook.result.current.analyzeClip(options(video));
    });
    const truncatedOutcome = truncatedRun.then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    await fireNextVideoFrame(1.8);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    // Chrome can snap currentTime to the declared duration for a truncated
    // fast-start MP4. The last presented frame remains the reliable endpoint.
    await endVideo(video);

    await expect(truncatedOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/ended before.*window|damaged|incomplete/i)
    });
    expect(hook.result.current.clipBusy).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(WorkerStub.instances).toHaveLength(1);
    expect(pendingVideoFrames).toHaveLength(0);

    video.currentTime = 0;
    Object.defineProperty(video, "ended", { configurable: true, value: false });
    let recoveredRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      recoveredRun = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(3.916);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(2));
    await emitResult(worker, worker.frameRequests[1]);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await endVideo(video);

    await expect(recoveredRun).resolves.toMatchObject({ processedFrames: 1 });
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(WorkerStub.instances).toHaveLength(1);
  });

  it("does not mistake slow Worker inference for a decoder stall", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    vi.useFakeTimers();
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
      void analysisPromise.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        }
      );
    });
    await flushMicrotasks();
    await fireNextVideoFrame(0.1);
    await flushMicrotasks();
    expect(worker.frameRequests).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100);
    });

    expect(outcome).toBe("pending");
    expect(hook.result.current.clipBusy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    await emitResult(worker, worker.frameRequests[0]);
    await flushMicrotasks();
    await fireNextVideoFrame(4);

    await expect(analysisPromise).resolves.toMatchObject({ processedFrames: 1 });
    expect(outcome).toBe("resolved");
  });

  it("times out only while awaiting a decoded frame and lets a retry succeed", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    vi.useFakeTimers();
    let firstRun!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      firstRun = hook.result.current.analyzeClip(options(video));
    });
    const firstOutcome = firstRun.then(
      () => null,
      (error: unknown) => error
    );
    await flushMicrotasks();
    expect(pendingVideoFrames).toHaveLength(1);
    await fireNextVideoFrame(0.1);
    await flushMicrotasks();
    expect(worker.frameRequests).toHaveLength(1);
    await emitResult(worker, worker.frameRequests[0]);
    await flushMicrotasks();
    expect(pendingVideoFrames).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100);
    });

    await expect(firstOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/decod|producing frames|stalled/i)
    });
    expect(hook.result.current.clipBusy).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(WorkerStub.instances).toHaveLength(1);
    expect(pendingVideoFrames).toHaveLength(0);

    let recoveredRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      recoveredRun = hook.result.current.analyzeClip(options(video));
    });
    await flushMicrotasks();
    await fireNextVideoFrame(0.1);
    await flushMicrotasks();
    expect(worker.frameRequests).toHaveLength(2);

    await emitResult(worker, worker.frameRequests[1]);
    await flushMicrotasks();
    await fireNextVideoFrame(4);

    await expect(recoveredRun).resolves.toMatchObject({ processedFrames: 1 });
    expect(hook.result.current.clipBusy).toBe(false);
  });

  it("reports an in-play media decode failure as a codec-specific video error", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo({ duration: 4 });
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(video));
    });
    const outcome = analysisPromise.then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));

    await failVideoDecode(video);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringMatching(/codec|corrupt|decod|unsupported/i)
    });
    expect(hook.result.current.clipBusy).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(pendingVideoFrames).toHaveLength(0);
  });

  it("closes an untransferred bitmap after postMessage throws and cleanly runs another job", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo();
    worker.throwOnNextFrame = new Error("Frame transfer failed.");
    let failedRun!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      failedRun = hook.result.current.analyzeClip(options(video));
    });
    const failedExpectation = expect(failedRun).rejects.toThrow("Frame transfer failed.");
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await failedExpectation;

    expect(createdBitmapCloseMocks[0]).toHaveBeenCalledOnce();
    expect(worker.frameRequests).toHaveLength(0);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(video.playbackRate).toBe(1);
    await waitFor(() => expect(hook.result.current.clipBusy).toBe(false));
    expect(pendingVideoFrames).toHaveLength(0);

    let recoveredRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      recoveredRun = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    expect(worker.frameRequests[0].jobId).toBe(2);
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(3));
    await fireNextVideoFrame(4);
    await expect(recoveredRun).resolves.toMatchObject({ processedFrames: 1 });
    expect(WorkerStub.instances).toHaveLength(1);
  });

  it("times out frame extraction separately and keeps late bitmap completion isolated", async () => {
    const firstBitmap = deferred<ImageBitmap>();
    const firstClose = vi.fn();
    const laterClose = vi.fn();
    createImageBitmapMock
      .mockReset()
      .mockImplementationOnce(() => firstBitmap.promise)
      .mockResolvedValue({ close: laterClose } as unknown as ImageBitmap);

    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const video = makeVideo();
    vi.useFakeTimers();

    let firstRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      firstRun = hook.result.current.analyzeClip(options(video));
    });
    const firstOutcome = firstRun.then(
      () => null,
      (error: unknown) => error
    );
    await flushMicrotasks();
    await fireNextVideoFrame(0.1);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100);
    });
    expect(hook.result.current.clipBusy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await expect(firstOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/extracting.*frame.*too long/i)
    });
    expect(worker.terminate).not.toHaveBeenCalled();

    let secondRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      secondRun = hook.result.current.analyzeClip(options(video));
    });
    await flushMicrotasks();
    const repeatedCallback = pendingVideoFrames.values().next().value as
      | VideoFrameRequestCallback
      | undefined;
    await fireNextVideoFrame(0.1);
    await flushMicrotasks();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
    expect(worker.frameRequests).toHaveLength(1);

    firstBitmap.resolve({ close: firstClose } as unknown as ImageBitmap);
    await flushMicrotasks();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(worker.frameRequests).toHaveLength(1);

    await act(async () => {
      repeatedCallback?.(600, { mediaTime: 0.2 } as VideoFrameCallbackMetadata);
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
    expect(worker.frameRequests).toHaveLength(1);
    pendingVideoFrames.clear();

    await emitResult(worker, worker.frameRequests[0]);
    await flushMicrotasks();
    await fireNextVideoFrame(4);
    await expect(secondRun).resolves.toMatchObject({ processedFrames: 1 });
  });

  it("replaces a silent Worker after the processing timeout and accepts a new job", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const firstWorker = latestWorker();
    const video = makeVideo();
    vi.useFakeTimers();

    let firstRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      firstRun = hook.result.current.analyzeClip(options(video));
    });
    const firstOutcome = firstRun.then(
      () => null,
      (error: unknown) => error
    );
    await flushMicrotasks();
    await fireNextVideoFrame(0.1);
    expect(firstWorker.frameRequests).toHaveLength(1);
    const staleRequest = firstWorker.frameRequests[0];
    const staleHandler = firstWorker.onmessage;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100);
    });
    expect(hook.result.current.clipBusy).toBe(true);
    expect(firstWorker.terminate).not.toHaveBeenCalled();
    expect(WorkerStub.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await expect(firstOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/pose engine.*stopped responding/i)
    });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.instances).toHaveLength(2);
    expect(hook.result.current.modelStatus).toBe("loading");
    await expect(hook.result.current.analyzeClip(options(video))).rejects.toThrow(
      "The on-device pose model is not ready yet."
    );

    const replacementWorker = latestWorker();
    await act(async () => replacementWorker.emitReady());
    expect(hook.result.current.modelStatus).toBe("ready");

    let secondRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      secondRun = hook.result.current.analyzeClip(options(video));
    });
    await flushMicrotasks();
    await fireNextVideoFrame(0.1);
    await flushMicrotasks();
    expect(replacementWorker.frameRequests).toHaveLength(1);

    await act(async () => {
      staleHandler?.(
        new MessageEvent("message", {
          data: {
            type: "result",
            channel: staleRequest.channel,
            jobId: staleRequest.jobId,
            frameId: staleRequest.frameId,
            engineTimestamp: staleRequest.engineTimestamp,
            sourceTimestamp: staleRequest.sourceTimestamp,
            inferenceMs: 4,
            poseCount: 0,
            landmarks: null,
            worldLandmarks: null
          } satisfies PoseWorkerResponse
        })
      );
      await Promise.resolve();
    });
    expect(replacementWorker.frameRequests).toHaveLength(1);
    expect(pendingVideoFrames).toHaveLength(0);

    await emitResult(replacementWorker, replacementWorker.frameRequests[0]);
    await flushMicrotasks();
    await fireNextVideoFrame(4);
    await expect(secondRun).resolves.toMatchObject({ processedFrames: 1 });
  });

  it("terminates a failed current Worker once and leaves the model fail-closed", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const workerErrorHandler = worker.onerror;
    const video = makeVideo();
    let run!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      run = hook.result.current.analyzeClip(options(video));
    });
    const outcome = run.then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));

    await act(async () => {
      workerErrorHandler?.();
      await Promise.resolve();
    });

    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.instances).toHaveLength(1);
    expect(hook.result.current.modelStatus).toBe("error");
    expect(hook.result.current.modelDelegate).toBeNull();
    expect(hook.result.current.clipBusy).toBe(false);
    expect(hook.result.current.modelError).toMatch(/background pose engine stopped/i);
    await expect(hook.result.current.analyzeClip(options(video))).rejects.toThrow(
      "The on-device pose model is not ready yet."
    );

    await act(async () => {
      workerErrorHandler?.();
      await Promise.resolve();
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.instances).toHaveLength(1);
    expect(hook.result.current.modelStatus).toBe("error");
  });

  it("uses the settings snapshot captured when clip analysis begins", async () => {
    const hook = renderHook(
      ({ coachSettings }: { coachSettings: CoachSettings }) => usePoseCoach(coachSettings, layers),
      { initialProps: { coachSettings: { ...settings, sideView: true } } }
    );
    await makeModelReady(hook);
    const worker = latestWorker();
    const pose = makeFinitePose();
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(makeVideo()));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));

    act(() => hook.rerender({ coachSettings: { ...settings, sideView: false } }));
    await emitResult(worker, worker.frameRequests[0], { poseCount: 1, ...pose });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    await fireNextVideoFrame(4);
    const run = await analysisPromise;

    expect(run.supportedFrames).toBe(1);
    expect(run.samples).toHaveLength(1);
    expect(run.samples[0].analysis.metrics.cameraQuality).toBeCloseTo(0.28);
  });

  it("counts a frame as supported only when exactly one person is detected", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const pose = makeFinitePose();
    let analysisPromise!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      analysisPromise = hook.result.current.analyzeClip(options(makeVideo()));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    await emitResult(worker, worker.frameRequests[0], { poseCount: 2, ...pose });

    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    await fireNextVideoFrame(0.2);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(2));
    await emitResult(worker, worker.frameRequests[1], { poseCount: 1, ...pose });

    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(3));
    await fireNextVideoFrame(4);
    await expect(analysisPromise).resolves.toMatchObject({
      processedFrames: 2,
      supportedFrames: 1,
      samples: [{ sourceTimestamp: 200 }]
    });
  });

  it("reuses the Worker when cancellation happens before a frame is submitted", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    let run!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      run = hook.result.current.analyzeClip(options(makeVideo()));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));

    act(() => hook.result.current.cancelClipAnalysis());

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(WorkerStub.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(pendingVideoFrames).toHaveLength(0);
  });

  it("replaces a Worker when cancellation abandons a transferred frame", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const firstWorker = latestWorker();
    const video = makeVideo();
    let firstRun!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      firstRun = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(firstWorker.frameRequests).toHaveLength(1));
    const cancelledRequest = firstWorker.frameRequests[0];

    act(() => hook.result.current.cancelClipAnalysis());
    await expect(firstRun).rejects.toMatchObject({ name: "AbortError" });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.instances).toHaveLength(2);
    expect(hook.result.current.modelStatus).toBe("loading");

    // The detached Worker cannot release or write through a stale result.
    firstWorker.emitResult(cancelledRequest);
    const replacementWorker = latestWorker();
    await act(async () => replacementWorker.emitReady());
    await waitFor(() => expect(hook.result.current.modelStatus).toBe("ready"));

    let secondRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      secondRun = hook.result.current.analyzeClip(options(video));
    });
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(replacementWorker.frameRequests).toHaveLength(1));
    const secondRequest = replacementWorker.frameRequests[0];

    expect(secondRequest.jobId).toBeGreaterThan(cancelledRequest.jobId);
    await emitResult(replacementWorker, secondRequest);
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(3));
    await fireNextVideoFrame(4);
    await expect(secondRun).resolves.toMatchObject({ processedFrames: 1 });
    expect(replacementWorker.terminate).not.toHaveBeenCalled();
  });

  it("closes a pending live bitmap abandoned before effect cleanup and reuses the Worker", async () => {
    const pendingBitmap = deferred<ImageBitmap>();
    const abandonedClose = vi.fn();
    createImageBitmapMock
      .mockReset()
      .mockImplementationOnce(() => pendingBitmap.promise)
      .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap);

    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const worker = latestWorker();
    const liveVideo = makeVideo();
    Object.defineProperty(liveVideo, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA
    });
    const track = {
      onended: null,
      stop: vi.fn()
    } as unknown as MediaStreamTrack;
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track]
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) }
    });

    act(() => hook.result.current.attachVideo(liveVideo));
    await act(async () => hook.result.current.startCamera());
    await waitFor(() => expect(hook.result.current.mode).toBe("live"));
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(0.1);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(worker.frameRequests).toHaveLength(0);

    await act(async () => {
      hook.result.current.endSession();
      pendingBitmap.resolve({ close: abandonedClose } as unknown as ImageBitmap);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(abandonedClose).toHaveBeenCalledOnce();
    expect(worker.frameRequests).toHaveLength(0);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(hook.result.current.mode).toBe("ready");
    expect(hook.result.current.modelStatus).toBe("ready");

    let clipRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      clipRun = hook.result.current.analyzeClip(options(makeVideo()));
    });
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(worker.frameRequests).toHaveLength(1));
    await emitResult(worker, worker.frameRequests[0]);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(4);
    await expect(clipRun).resolves.toMatchObject({ processedFrames: 1 });
  });

  it("preserves live backpressure and recovers a silent live frame when the session ends", async () => {
    const hook = renderHook(() => usePoseCoach(settings, layers));
    await makeModelReady(hook);
    const firstWorker = latestWorker();
    let cancelledRun!: ReturnType<typeof hook.result.current.analyzeClip>;

    act(() => {
      cancelledRun = hook.result.current.analyzeClip(options(makeVideo()));
    });
    const cancelledOutcome = cancelledRun.then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(firstWorker.frameRequests).toHaveLength(1));
    act(() => hook.result.current.cancelClipAnalysis());
    await expect(cancelledOutcome).resolves.toMatchObject({ name: "AbortError" });

    const replacementWorker = latestWorker();
    await act(async () => replacementWorker.emitReady());
    await waitFor(() => expect(hook.result.current.modelStatus).toBe("ready"));

    const liveVideo = makeVideo();
    Object.defineProperty(liveVideo, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA
    });
    const track = {
      onended: null,
      stop: vi.fn()
    } as unknown as MediaStreamTrack;
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track]
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) }
    });

    act(() => hook.result.current.attachVideo(liveVideo));
    await act(async () => hook.result.current.startCamera());
    await waitFor(() => expect(hook.result.current.mode).toBe("live"));
    await waitFor(() => expect(requestVideoFrameCallbackMock).toHaveBeenCalledTimes(2));

    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(replacementWorker.frameRequests).toHaveLength(1));
    await fireNextVideoFrame(0.2);
    expect(replacementWorker.frameRequests).toHaveLength(1);

    act(() => hook.result.current.endSession());
    expect(track.stop).toHaveBeenCalledOnce();
    expect(replacementWorker.terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.instances).toHaveLength(3);
    expect(hook.result.current.mode).toBe("ready");
    expect(hook.result.current.modelStatus).toBe("loading");

    const recoveredWorker = latestWorker();
    await act(async () => recoveredWorker.emitReady());
    await waitFor(() => expect(hook.result.current.modelStatus).toBe("ready"));

    let recoveredRun!: ReturnType<typeof hook.result.current.analyzeClip>;
    act(() => {
      recoveredRun = hook.result.current.analyzeClip(options(makeVideo()));
    });
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(0.1);
    await waitFor(() => expect(recoveredWorker.frameRequests).toHaveLength(1));
    await emitResult(recoveredWorker, recoveredWorker.frameRequests[0]);
    await waitFor(() => expect(pendingVideoFrames).toHaveLength(1));
    await fireNextVideoFrame(4);
    await expect(recoveredRun).resolves.toMatchObject({ processedFrames: 1 });

  });
});
