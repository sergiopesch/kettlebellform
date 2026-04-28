import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const TASKS_VERSION = "0.10.35";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const HEAVY_POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task";

export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);

  const create = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HEAVY_POSE_MODEL,
        delegate
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.62,
      minPosePresenceConfidence: 0.62,
      minTrackingConfidence: 0.65,
      outputSegmentationMasks: false
    });

  try {
    return await create("GPU");
  } catch {
    return create("CPU");
  }
}
