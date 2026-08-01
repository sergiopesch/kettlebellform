import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";

export type PoseWorkerChannel = "live" | "clip";

export type PoseWorkerInitializeRequest = {
  type: "initialize";
};

export type PoseWorkerFrameRequest = {
  type: "frame";
  channel: PoseWorkerChannel;
  jobId: number;
  frameId: number;
  frame: ImageBitmap;
  /** Monotonic milliseconds shared by every frame, job, and channel. */
  engineTimestamp: number;
  /** Milliseconds on the originating camera or clip timeline. */
  sourceTimestamp: number;
};

export type PoseWorkerCloseRequest = {
  type: "close";
};

export type PoseWorkerRequest =
  | PoseWorkerInitializeRequest
  | PoseWorkerFrameRequest
  | PoseWorkerCloseRequest;

export type PoseWorkerReadyMessage = {
  type: "ready";
  delegate: "GPU" | "CPU";
  version: string;
};

export type PoseWorkerResultMessage = {
  type: "result";
  channel: PoseWorkerChannel;
  jobId: number;
  frameId: number;
  engineTimestamp: number;
  sourceTimestamp: number;
  inferenceMs: number;
  /** Number of people detected before selecting the primary pose. */
  poseCount: number;
  landmarks: NormalizedLandmark[] | null;
  worldLandmarks: Landmark[] | null;
};

export type PoseWorkerErrorMessage = {
  type: "error";
  fatal: boolean;
  message: string;
  /** Initialization errors have no frame envelope and therefore use nulls. */
  channel: PoseWorkerChannel | null;
  jobId: number | null;
  frameId: number | null;
  engineTimestamp: number | null;
  sourceTimestamp: number | null;
};

export type PoseWorkerResponse =
  | PoseWorkerReadyMessage
  | PoseWorkerResultMessage
  | PoseWorkerErrorMessage;
