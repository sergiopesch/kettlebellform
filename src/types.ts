import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { Vec2, Vec3 } from "./lib/geometry";

export type ExperienceLevel = "new" | "trained" | "advanced";

export type CoachingGoal = "technique" | "power" | "rehab";

export type AnatomyLayerId = "body" | "muscles" | "skeleton" | "gaussian";

export type AnatomyLayerState = Record<AnatomyLayerId, boolean>;

export type CoachSettings = {
  heightCm: number;
  bellKg: number;
  experience: ExperienceLevel;
  goal: CoachingGoal;
  sideView: boolean;
};

export type CalibrationProfile = {
  createdAt: number;
  sampleCount: number;
  uprightHipAngle: number;
  uprightKneeAngle: number;
  uprightTorsoLean: number;
  shoulderWidth: number;
  torsoLength: number;
  confidence: number;
  jitter: number;
};

export type SwingPhase = "waiting" | "backswing" | "drive" | "float" | "lockout";

export type FeedbackSeverity = "good" | "watch" | "fix";

export type FeedbackSignal = {
  id: string;
  label: string;
  detail: string;
  severity: FeedbackSeverity;
  score: number;
  joint?: "hips" | "knees" | "spine" | "shoulders" | "camera";
};

export type PoseFrame = {
  timestamp: number;
  landmarks: NormalizedLandmark[];
  worldLandmarks: Landmark[];
};

export type SwingMetrics = {
  hipAngle: number;
  kneeAngle: number;
  hipFlexionDelta: number;
  kneeFlexionDelta: number;
  hingeRatio: number;
  torsoLean: number;
  shoulderLift: number;
  wristHeight: number;
  wristDepth: number;
  spineStack: number;
  visibility: number;
  cameraQuality: number;
  smoothness: number;
  depthTravel: number;
  repVelocity: number;
};

export type JointRisk = {
  index: number;
  center: Vec2;
  depth: number;
  radius: number;
  intensity: number;
  color: string;
};

export type AnalysisFrame = {
  phase: SwingPhase;
  repCount: number;
  score: number;
  confidence: number;
  metrics: SwingMetrics;
  feedback: FeedbackSignal[];
  jointRisks: JointRisk[];
  worldLandmarks: Landmark[];
  landmarks: NormalizedLandmark[];
  wristTrail: Vec3[];
};
