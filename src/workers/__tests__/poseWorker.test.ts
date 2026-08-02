import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoseWorkerFrameRequest } from "../poseProtocol";

const workerMocks = vi.hoisted(() => {
  const engine = {
    close: vi.fn(),
    detect: vi.fn(),
    detectForVideo: vi.fn(),
    setOptions: vi.fn()
  };
  return {
    createFromOptions: vi.fn(),
    engine,
    forVisionTasks: vi.fn()
  };
});

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: workerMocks.forVisionTasks },
  PoseLandmarker: { createFromOptions: workerMocks.createFromOptions }
}));

type WorkerScopeHarness = {
  close: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

function pose() {
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
  return { landmarks, worldLandmarks };
}

function frameRequest(jobId: number, frameId: number): PoseWorkerFrameRequest {
  return {
    type: "frame",
    channel: "live",
    jobId,
    frameId,
    frame: { close: vi.fn() } as unknown as ImageBitmap,
    engineTimestamp: jobId * 100 + frameId + 1,
    sourceTimestamp: jobId * 100 + frameId + 1
  };
}

describe("pose worker live ambiguity boundary", () => {
  let scope: WorkerScopeHarness;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    workerMocks.forVisionTasks.mockResolvedValue({
      wasmLoaderPath: "",
      wasmBinaryPath: ""
    });
    workerMocks.createFromOptions.mockResolvedValue(workerMocks.engine);
    const first = pose();
    const second = pose();
    workerMocks.engine.detectForVideo.mockReturnValue({
      landmarks: [first.landmarks, second.landmarks],
      worldLandmarks: [first.worldLandmarks, second.worldLandmarks]
    });
    workerMocks.engine.setOptions.mockResolvedValue(undefined);
    scope = {
      close: vi.fn(),
      onmessage: null,
      postMessage: vi.fn()
    };
    vi.stubGlobal("self", scope);
    await import("../poseWorker");
  });

  it("requests two live poses during initialization and every tracker reset", async () => {
    expect(scope.onmessage).not.toBeNull();
    await scope.onmessage!(new MessageEvent("message", { data: { type: "initialize" } }));

    expect(workerMocks.createFromOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runningMode: "VIDEO", numPoses: 2 })
    );

    await scope.onmessage!(
      new MessageEvent("message", { data: frameRequest(1, 0) })
    );
    expect(workerMocks.engine.setOptions).toHaveBeenCalledWith({
      runningMode: "VIDEO",
      numPoses: 2
    });
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "result",
        channel: "live",
        poseCount: 2
      })
    );

    workerMocks.engine.setOptions.mockClear();
    await scope.onmessage!(
      new MessageEvent("message", { data: frameRequest(2, 0) })
    );
    expect(workerMocks.engine.setOptions.mock.calls).toEqual([
      [{ runningMode: "IMAGE", numPoses: 2 }],
      [{ runningMode: "VIDEO", numPoses: 2 }]
    ]);
  });
});
