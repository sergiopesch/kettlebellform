/// <reference lib="webworker" />

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const TASKS_VERSION = "0.10.35";
const WASM_BASE = `/vendor/mediapipe/${TASKS_VERSION}`;
const POSE_MODEL = "/models/pose_landmarker_full-float16-v1.task";

type WorkerRequest =
  | { type: "initialize" }
  | { type: "frame"; frame: ImageBitmap; timestamp: number }
  | { type: "close" };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: PoseLandmarker | null = null;

async function initialize(): Promise<void> {
  const create = async (delegate: "GPU" | "CPU") => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    // MediaPipe clears ModuleFactory after initialization. A failed GPU setup
    // therefore needs a distinct module URL so the CPU retry executes the ESM
    // loader again instead of receiving the browser's cached module instance.
    vision.wasmLoaderPath = `${WASM_BASE}/vision_wasm_module_internal.js?delegate=${delegate.toLowerCase()}`;
    vision.wasmBinaryPath = `${WASM_BASE}/vision_wasm_module_internal.wasm`;
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: POSE_MODEL,
        delegate
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.66,
      minPosePresenceConfidence: 0.66,
      minTrackingConfidence: 0.68,
      outputSegmentationMasks: false
    });
  };

  let delegate: "GPU" | "CPU" = "GPU";
  try {
    landmarker = await create("GPU");
  } catch (gpuError) {
    delegate = "CPU";
    try {
      landmarker = await create("CPU");
    } catch (cpuError) {
      const gpuMessage = gpuError instanceof Error ? gpuError.message : "unknown GPU error";
      const cpuMessage = cpuError instanceof Error ? cpuError.message : "unknown CPU error";
      throw new Error(`Pose engine initialization failed. GPU: ${gpuMessage}. CPU: ${cpuMessage}.`, {
        cause: cpuError
      });
    }
  }

  workerScope.postMessage({ type: "ready", delegate, version: TASKS_VERSION });
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "initialize") {
    try {
      await initialize();
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        fatal: true,
        message: error instanceof Error ? error.message : "The pose model could not be initialized."
      });
    }
    return;
  }

  if (message.type === "close") {
    landmarker?.close();
    landmarker = null;
    workerScope.close();
    return;
  }

  const startedAt = performance.now();
  try {
    if (!landmarker) {
      throw new Error("Pose model is not ready.");
    }

    const result = landmarker.detectForVideo(message.frame, message.timestamp);
    workerScope.postMessage({
      type: "result",
      timestamp: message.timestamp,
      inferenceMs: performance.now() - startedAt,
      landmarks: result.landmarks[0] ?? null,
      worldLandmarks: result.worldLandmarks[0] ?? null
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      fatal: false,
      message: error instanceof Error ? error.message : "This video frame could not be analyzed."
    });
  } finally {
    message.frame.close();
  }
};

export {};
