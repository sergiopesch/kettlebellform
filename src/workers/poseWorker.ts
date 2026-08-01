/// <reference lib="webworker" />

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type {
  PoseWorkerErrorMessage,
  PoseWorkerFrameRequest,
  PoseWorkerReadyMessage,
  PoseWorkerRequest,
  PoseWorkerResultMessage
} from "./poseProtocol";

const TASKS_VERSION = "0.10.35";
const WASM_BASE = `/vendor/mediapipe/${TASKS_VERSION}`;
const POSE_MODEL = "/models/pose_landmarker_full-float16-v1.task";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: PoseLandmarker | null = null;
let initialization: Promise<EngineDetails> | null = null;
let engineDetails: EngineDetails | null = null;
let lastEngineTimestamp = Number.NEGATIVE_INFINITY;
let activeChannel: PoseWorkerFrameRequest["channel"] | null = null;
let activeJobId: number | null = null;

type EngineDetails = {
  delegate: "GPU" | "CPU";
  version: string;
};

function postMessage(message: PoseWorkerReadyMessage | PoseWorkerResultMessage | PoseWorkerErrorMessage) {
  workerScope.postMessage(message);
}

async function createEngine(): Promise<EngineDetails> {
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

  return { delegate, version: TASKS_VERSION };
}

async function initialize(): Promise<EngineDetails> {
  if (landmarker && engineDetails) {
    return engineDetails;
  }

  if (!initialization) {
    initialization = createEngine()
      .then((details) => {
        engineDetails = details;
        return details;
      })
      .catch((error: unknown) => {
        initialization = null;
        engineDetails = null;
        landmarker = null;
        throw error;
      });
  }

  return initialization;
}

async function configureForFrame(message: PoseWorkerFrameRequest): Promise<void> {
  if (!landmarker) {
    throw new Error("Pose model is not ready.");
  }

  if (message.channel === "clip") {
    if (activeChannel !== "clip") {
      // Clip frames are intentionally independent. IMAGE mode avoids carrying
      // MediaPipe's temporal tracking state across seeks, uploads, or jobs.
      await landmarker.setOptions({ runningMode: "IMAGE", numPoses: 2 });
    }
  } else if (activeChannel !== "live") {
    await landmarker.setOptions({ runningMode: "VIDEO", numPoses: 1 });
  } else if (activeJobId !== null && activeJobId !== message.jobId) {
    // Force a tracker reset when a new camera stream reuses this Worker.
    await landmarker.setOptions({ runningMode: "IMAGE", numPoses: 1 });
    await landmarker.setOptions({ runningMode: "VIDEO", numPoses: 1 });
  }

  activeChannel = message.channel;
  activeJobId = message.jobId;
}

function validateFrameEnvelope(message: PoseWorkerFrameRequest): void {
  if (!Number.isSafeInteger(message.jobId) || message.jobId < 0) {
    throw new Error("Pose frame jobId must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(message.frameId) || message.frameId < 0) {
    throw new Error("Pose frame frameId must be a non-negative safe integer.");
  }
  if (!Number.isFinite(message.sourceTimestamp)) {
    throw new Error("Pose frame sourceTimestamp must be finite.");
  }
  if (!Number.isFinite(message.engineTimestamp)) {
    throw new Error("Pose frame engineTimestamp must be finite.");
  }
  if (message.engineTimestamp <= lastEngineTimestamp) {
    throw new Error("Pose frame engineTimestamp must increase globally across channels and jobs.");
  }

  lastEngineTimestamp = message.engineTimestamp;
}

workerScope.onmessage = async (event: MessageEvent<PoseWorkerRequest>) => {
  const message = event.data;

  if (message.type === "initialize") {
    try {
      const details = await initialize();
      postMessage({ type: "ready", ...details });
    } catch (error) {
      postMessage({
        type: "error",
        fatal: true,
        message: error instanceof Error ? error.message : "The pose model could not be initialized.",
        channel: null,
        jobId: null,
        frameId: null,
        engineTimestamp: null,
        sourceTimestamp: null
      });
    }
    return;
  }

  if (message.type === "close") {
    landmarker?.close();
    landmarker = null;
    engineDetails = null;
    initialization = null;
    activeChannel = null;
    activeJobId = null;
    workerScope.close();
    return;
  }

  const startedAt = performance.now();
  try {
    if (!landmarker) {
      throw new Error("Pose model is not ready.");
    }

    validateFrameEnvelope(message);
    await configureForFrame(message);
    const result = message.channel === "clip"
      ? landmarker.detect(message.frame)
      : landmarker.detectForVideo(message.frame, message.engineTimestamp);
    postMessage({
      type: "result",
      channel: message.channel,
      jobId: message.jobId,
      frameId: message.frameId,
      engineTimestamp: message.engineTimestamp,
      sourceTimestamp: message.sourceTimestamp,
      inferenceMs: performance.now() - startedAt,
      poseCount: result.landmarks.length,
      landmarks: result.landmarks[0] ?? null,
      worldLandmarks: result.worldLandmarks[0] ?? null
    });
  } catch (error) {
    postMessage({
      type: "error",
      fatal: false,
      message: error instanceof Error ? error.message : "This video frame could not be analyzed.",
      channel: message.channel,
      jobId: message.jobId,
      frameId: message.frameId,
      engineTimestamp: message.engineTimestamp,
      sourceTimestamp: message.sourceTimestamp
    });
  } finally {
    message.frame.close();
  }
};

export {};
