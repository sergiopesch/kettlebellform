import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { POSE } from "./landmarks";
import {
  angleBetween,
  asVec2,
  asVec3,
  clamp,
  directionAngleFromScreenVertical,
  distance3,
  jointAngle,
  mean,
  median,
  midpoint2,
  midpoint3,
  standardDeviation,
  sub2,
  sub3,
  visibilityOf
} from "./geometry";
import type {
  AnalysisFrame,
  CalibrationProfile,
  CoachSettings,
  FeedbackSignal,
  JointRisk,
  PoseFrame,
  SwingMetrics,
  SwingPhase
} from "../types";

type MetricSample = {
  timestamp: number;
  hipAngle: number;
  hipFlexionDelta: number;
  kneeFlexionDelta: number;
  wristHeight: number;
  wristDepth: number;
};

const DEFAULT_PROFILE: CalibrationProfile = {
  createdAt: 0,
  sampleCount: 0,
  uprightHipAngle: 168,
  uprightKneeAngle: 174,
  uprightTorsoLean: 4,
  shoulderWidth: 0.36,
  torsoLength: 0.52,
  confidence: 0.55,
  jitter: 6
};

const calibrationIndices = [
  POSE.leftShoulder,
  POSE.rightShoulder,
  POSE.leftHip,
  POSE.rightHip,
  POSE.leftKnee,
  POSE.rightKnee,
  POSE.leftAnkle,
  POSE.rightAnkle
];

export function createCalibrationProfile(samples: PoseFrame[]): CalibrationProfile | null {
  const measured = samples
    .map((sample) => measureBasic(sample.landmarks, sample.worldLandmarks))
    .filter((metrics) => metrics.visibility > 0.55);

  if (measured.length < 12) {
    return null;
  }

  return {
    createdAt: Date.now(),
    sampleCount: measured.length,
    uprightHipAngle: median(measured.map((metric) => metric.hipAngle)),
    uprightKneeAngle: median(measured.map((metric) => metric.kneeAngle)),
    uprightTorsoLean: median(measured.map((metric) => metric.torsoLean)),
    shoulderWidth: median(measured.map((metric) => metric.shoulderWidth)),
    torsoLength: median(measured.map((metric) => metric.torsoLength)),
    confidence: clamp(mean(measured.map((metric) => metric.visibility)), 0, 1),
    jitter: standardDeviation(measured.map((metric) => metric.hipAngle))
  };
}

export class SwingAnalyzer {
  private phase: SwingPhase = "waiting";
  private repCount = 0;
  private history: MetricSample[] = [];
  private wristTrail = [] as Array<{ x: number; y: number; z: number }>;
  private loadedBackswing = false;
  private lastRepAt = 0;

  reset(): void {
    this.phase = "waiting";
    this.repCount = 0;
    this.history = [];
    this.wristTrail = [];
    this.loadedBackswing = false;
    this.lastRepAt = 0;
  }

  update(frame: PoseFrame, settings: CoachSettings, calibration?: CalibrationProfile | null): AnalysisFrame {
    const profile = calibration ?? DEFAULT_PROFILE;
    const metrics = measureSwing(frame.landmarks, frame.worldLandmarks, profile, settings, this.history);
    const now = frame.timestamp;
    const sample = {
      timestamp: now,
      hipAngle: metrics.hipAngle,
      hipFlexionDelta: metrics.hipFlexionDelta,
      kneeFlexionDelta: metrics.kneeFlexionDelta,
      wristHeight: metrics.wristHeight,
      wristDepth: metrics.wristDepth
    };

    this.history.push(sample);
    this.history = this.history.filter((item) => now - item.timestamp < 4500);

    const previous = this.history.at(-2);
    const dt = previous ? Math.max(16, now - previous.timestamp) / 1000 : 1 / 30;
    const hipVelocity = previous ? (sample.hipFlexionDelta - previous.hipFlexionDelta) / dt : 0;
    metrics.repVelocity = Math.abs(hipVelocity);

    this.wristTrail.push(getWristWorld(frame.worldLandmarks));
    this.wristTrail = this.wristTrail.slice(-90);

    const thresholds = getThresholds(settings);
    if (metrics.hipFlexionDelta > thresholds.bottom) {
      this.loadedBackswing = true;
    }

    if (
      this.loadedBackswing &&
      metrics.hipFlexionDelta < thresholds.top &&
      metrics.wristHeight > 0.18 &&
      now - this.lastRepAt > 650
    ) {
      this.repCount += 1;
      this.loadedBackswing = false;
      this.lastRepAt = now;
    }

    this.phase = classifyPhase(metrics, hipVelocity, thresholds);
    const feedback = buildFeedback(metrics, settings, this.phase, thresholds, this.repCount);
    const jointRisks = buildJointRisks(frame.landmarks, metrics, feedback);
    const score = scoreFrame(metrics, feedback);

    return {
      phase: this.phase,
      repCount: this.repCount,
      score,
      confidence: clamp(metrics.visibility * 0.5 + metrics.cameraQuality * 0.35 + metrics.smoothness * 0.15, 0, 1),
      metrics,
      feedback,
      jointRisks,
      worldLandmarks: frame.worldLandmarks,
      landmarks: frame.landmarks,
      wristTrail: [...this.wristTrail]
    };
  }
}

function getThresholds(settings: CoachSettings): { bottom: number; top: number; hingeRatio: number } {
  const experienceAdjustment = settings.experience === "new" ? -2 : settings.experience === "advanced" ? 3 : 0;
  const goalBottom = settings.goal === "power" ? 42 : settings.goal === "rehab" ? 30 : 36;
  const top = settings.goal === "rehab" ? 17 : settings.experience === "advanced" ? 10 : 14;
  const hingeRatio = settings.goal === "rehab" ? 1.25 : settings.experience === "advanced" ? 1.65 : 1.45;
  return {
    bottom: goalBottom + experienceAdjustment,
    top,
    hingeRatio
  };
}

function classifyPhase(
  metrics: SwingMetrics,
  hipVelocity: number,
  thresholds: { bottom: number; top: number }
): SwingPhase {
  if (metrics.visibility < 0.42) {
    return "waiting";
  }

  if (metrics.hipFlexionDelta > thresholds.bottom && hipVelocity > -20) {
    return "backswing";
  }

  if (metrics.hipFlexionDelta > thresholds.top && hipVelocity < -24) {
    return "drive";
  }

  if (metrics.hipFlexionDelta <= thresholds.top && metrics.wristHeight > 0.2) {
    return metrics.wristHeight > 0.44 ? "float" : "lockout";
  }

  return "waiting";
}

function measureBasic(landmarks: NormalizedLandmark[], worldLandmarks: Landmark[]) {
  const leftHipAngle = jointAngle(
    asVec3(worldLandmarks[POSE.leftShoulder]),
    asVec3(worldLandmarks[POSE.leftHip]),
    asVec3(worldLandmarks[POSE.leftKnee])
  );
  const rightHipAngle = jointAngle(
    asVec3(worldLandmarks[POSE.rightShoulder]),
    asVec3(worldLandmarks[POSE.rightHip]),
    asVec3(worldLandmarks[POSE.rightKnee])
  );
  const leftKneeAngle = jointAngle(
    asVec3(worldLandmarks[POSE.leftHip]),
    asVec3(worldLandmarks[POSE.leftKnee]),
    asVec3(worldLandmarks[POSE.leftAnkle])
  );
  const rightKneeAngle = jointAngle(
    asVec3(worldLandmarks[POSE.rightHip]),
    asVec3(worldLandmarks[POSE.rightKnee]),
    asVec3(worldLandmarks[POSE.rightAnkle])
  );

  const shoulderMid2 = midpoint2(asVec2(landmarks[POSE.leftShoulder]), asVec2(landmarks[POSE.rightShoulder]));
  const hipMid2 = midpoint2(asVec2(landmarks[POSE.leftHip]), asVec2(landmarks[POSE.rightHip]));
  const shoulderMid3 = midpoint3(asVec3(worldLandmarks[POSE.leftShoulder]), asVec3(worldLandmarks[POSE.rightShoulder]));
  const hipMid3 = midpoint3(asVec3(worldLandmarks[POSE.leftHip]), asVec3(worldLandmarks[POSE.rightHip]));

  return {
    hipAngle: mean([leftHipAngle, rightHipAngle]),
    kneeAngle: mean([leftKneeAngle, rightKneeAngle]),
    torsoLean: directionAngleFromScreenVertical(sub2(shoulderMid2, hipMid2)),
    shoulderWidth: distance3(asVec3(worldLandmarks[POSE.leftShoulder]), asVec3(worldLandmarks[POSE.rightShoulder])),
    torsoLength: distance3(shoulderMid3, hipMid3),
    visibility: visibilityOf([...landmarks], calibrationIndices)
  };
}

function measureSwing(
  landmarks: NormalizedLandmark[],
  worldLandmarks: Landmark[],
  profile: CalibrationProfile,
  settings: CoachSettings,
  history: MetricSample[]
): SwingMetrics {
  const basic = measureBasic(landmarks, worldLandmarks);
  const hipMid2 = midpoint2(asVec2(landmarks[POSE.leftHip]), asVec2(landmarks[POSE.rightHip]));
  const shoulderMid2 = midpoint2(asVec2(landmarks[POSE.leftShoulder]), asVec2(landmarks[POSE.rightShoulder]));
  const ankleMid2 = midpoint2(asVec2(landmarks[POSE.leftAnkle]), asVec2(landmarks[POSE.rightAnkle]));
  const wristMid2 = midpoint2(asVec2(landmarks[POSE.leftWrist]), asVec2(landmarks[POSE.rightWrist]));
  const wristWorld = getWristWorld(worldLandmarks);
  const shoulderMid3 = midpoint3(asVec3(worldLandmarks[POSE.leftShoulder]), asVec3(worldLandmarks[POSE.rightShoulder]));
  const hipMid3 = midpoint3(asVec3(worldLandmarks[POSE.leftHip]), asVec3(worldLandmarks[POSE.rightHip]));
  const bodyHeight = Math.max(0.15, Math.abs(ankleMid2.y - Math.min(landmarks[POSE.leftEar].y, landmarks[POSE.rightEar].y)));
  const screenShoulderWidth = Math.abs(landmarks[POSE.leftShoulder].x - landmarks[POSE.rightShoulder].x);
  const shoulderWidthRatio = screenShoulderWidth / bodyHeight;
  const cameraAngleQuality = settings.sideView ? 1 - clamp((shoulderWidthRatio - 0.2) / 0.28, 0, 1) : 1;
  const framingQuality = clamp((bodyHeight - 0.34) / 0.22, 0, 1);
  const cameraQuality = clamp(cameraAngleQuality * 0.72 + framingQuality * 0.28, 0, 1);
  const wristHeight = clamp((hipMid2.y - wristMid2.y) / bodyHeight, -0.35, 1);
  const shoulderLift = clamp((shoulderMid2.y - wristMid2.y) / bodyHeight, 0, 0.35);
  const hipFlexionDelta = clamp(profile.uprightHipAngle - basic.hipAngle, 0, 95);
  const kneeFlexionDelta = clamp(profile.uprightKneeAngle - basic.kneeAngle, 0, 95);
  const hingeRatio = hipFlexionDelta / Math.max(6, kneeFlexionDelta);
  const headMid = midpoint3(asVec3(worldLandmarks[POSE.leftEar]), asVec3(worldLandmarks[POSE.rightEar]));
  const torsoVector = sub3(shoulderMid3, hipMid3);
  const headVector = sub3(headMid, shoulderMid3);
  const neckDeviation = angleBetween(torsoVector, headVector);
  const topOverlean = Math.max(0, basic.torsoLean - Math.max(10, profile.uprightTorsoLean + 7));
  const spineStack = clamp(1 - (neckDeviation + topOverlean) / 50, 0, 1);
  const recentDepths = [...history.slice(-45).map((item) => item.wristDepth), wristWorld.z];
  const depthTravel = recentDepths.length > 2 ? Math.max(...recentDepths) - Math.min(...recentDepths) : 0;
  const recentAngles = [...history.slice(-25).map((item) => item.hipAngle), basic.hipAngle];
  const smoothness = clamp(1 - standardDeviation(recentAngles) / 32, 0.2, 1);

  return {
    hipAngle: basic.hipAngle,
    kneeAngle: basic.kneeAngle,
    hipFlexionDelta,
    kneeFlexionDelta,
    hingeRatio,
    torsoLean: basic.torsoLean,
    shoulderLift,
    wristHeight,
    wristDepth: wristWorld.z,
    spineStack,
    visibility: basic.visibility,
    cameraQuality,
    smoothness,
    depthTravel: normalizeDepthTravel(depthTravel, profile, settings),
    repVelocity: 0
  };
}

function normalizeDepthTravel(depthTravel: number, profile: CalibrationProfile, settings: CoachSettings): number {
  const estimatedTorso = Math.max(0.35, profile.torsoLength);
  const heightScale = clamp(settings.heightCm / 175, 0.82, 1.18);
  return clamp(depthTravel / (estimatedTorso * 0.55 * heightScale), 0, 1.4);
}

function getWristWorld(worldLandmarks: Landmark[]) {
  return midpoint3(asVec3(worldLandmarks[POSE.leftWrist]), asVec3(worldLandmarks[POSE.rightWrist]));
}

function buildFeedback(
  metrics: SwingMetrics,
  settings: CoachSettings,
  phase: SwingPhase,
  thresholds: { bottom: number; top: number; hingeRatio: number },
  repCount: number
): FeedbackSignal[] {
  const feedback: FeedbackSignal[] = [];
  const add = (signal: FeedbackSignal) => feedback.push(signal);

  if (metrics.visibility < 0.52) {
    add({
      id: "visibility",
      label: "Keep full body in frame",
      detail: "Feet, hips, shoulders, and hands need to stay visible for reliable coaching.",
      severity: "fix",
      score: metrics.visibility,
      joint: "camera"
    });
  }

  if (metrics.cameraQuality < 0.62) {
    add({
      id: "camera",
      label: "Use a cleaner side view",
      detail: "A side-on camera angle makes hip depth, knee travel, and bell path much more measurable.",
      severity: metrics.cameraQuality < 0.42 ? "fix" : "watch",
      score: metrics.cameraQuality,
      joint: "camera"
    });
  }

  if (phase === "backswing" && metrics.hingeRatio < thresholds.hingeRatio) {
    add({
      id: "hinge-ratio",
      label: "Hinge more than you squat",
      detail: "Push the hips back and keep knee bend secondary so the posterior chain drives the swing.",
      severity: metrics.hingeRatio < 1.05 ? "fix" : "watch",
      score: clamp(metrics.hingeRatio / thresholds.hingeRatio, 0, 1),
      joint: "knees"
    });
  }

  if (phase === "backswing" && metrics.hipFlexionDelta < thresholds.bottom + 8 && repCount > 0) {
    add({
      id: "hinge-depth",
      label: "Load the backswing deeper",
      detail: "The bell should pull you into a real hip hinge before the next drive.",
      severity: "watch",
      score: clamp(metrics.hipFlexionDelta / (thresholds.bottom + 8), 0, 1),
      joint: "hips"
    });
  }

  if ((phase === "float" || phase === "lockout") && metrics.hipFlexionDelta > thresholds.top + 6) {
    add({
      id: "finish-hips",
      label: "Finish tall through the hips",
      detail: "Stand into a vertical plank at the top instead of staying folded.",
      severity: "fix",
      score: clamp(1 - metrics.hipFlexionDelta / 40, 0, 1),
      joint: "hips"
    });
  }

  if ((phase === "float" || phase === "lockout") && metrics.shoulderLift > 0.055) {
    add({
      id: "arm-lift",
      label: "Let the bell float",
      detail: "Hands are rising above shoulder level; reduce shoulder pull and let hip drive set the height.",
      severity: metrics.shoulderLift > 0.1 || settings.bellKg > 24 ? "fix" : "watch",
      score: clamp(1 - metrics.shoulderLift / 0.18, 0, 1),
      joint: "shoulders"
    });
  }

  if ((phase === "float" || phase === "lockout") && metrics.spineStack < 0.68) {
    add({
      id: "spine-stack",
      label: "Stack ribs over hips",
      detail: "Avoid craning the neck or leaning back as the bell reaches the top.",
      severity: metrics.spineStack < 0.45 ? "fix" : "watch",
      score: metrics.spineStack,
      joint: "spine"
    });
  }

  if (repCount >= 2 && metrics.depthTravel < 0.18) {
    add({
      id: "depth-path",
      label: "Create a real backswing",
      detail: "The hands are not travelling far enough through depth; keep the lats connected and hike back.",
      severity: "watch",
      score: clamp(metrics.depthTravel / 0.35, 0, 1),
      joint: "hips"
    });
  }

  if (feedback.length === 0) {
    add({
      id: "clean",
      label: "Pattern looks clean",
      detail: "Hip timing, lockout, bell height, and camera confidence are inside the current tolerance.",
      severity: "good",
      score: 1,
      joint: "hips"
    });
  }

  return feedback.slice(0, 4);
}

function scoreFrame(metrics: SwingMetrics, feedback: FeedbackSignal[]): number {
  const penalty = feedback.reduce((total, signal) => {
    if (signal.severity === "good") {
      return total;
    }
    return total + (signal.severity === "fix" ? 18 : 9) * (1 - signal.score);
  }, 0);
  const confidencePenalty = (1 - metrics.visibility) * 20 + (1 - metrics.cameraQuality) * 12;
  const movementScore =
    metrics.spineStack * 20 +
    clamp(metrics.hingeRatio / 1.8, 0, 1) * 20 +
    clamp(1 - metrics.shoulderLift / 0.14, 0, 1) * 16 +
    metrics.smoothness * 14 +
    clamp(metrics.depthTravel, 0, 1) * 10 +
    20;
  return Math.round(clamp(movementScore - penalty - confidencePenalty, 0, 100));
}

function buildJointRisks(
  landmarks: NormalizedLandmark[],
  metrics: SwingMetrics,
  feedback: FeedbackSignal[]
): JointRisk[] {
  const risks: JointRisk[] = [];
  const addRisk = (index: number, intensity: number, color: string, radius = 0.07) => {
    risks.push({
      index,
      center: asVec2(landmarks[index]),
      depth: landmarks[index]?.z ?? 0,
      radius,
      intensity: clamp(intensity, 0, 1),
      color
    });
  };

  const uncertainty = clamp(1 - metrics.visibility, 0, 1);
  for (const index of [POSE.leftHip, POSE.rightHip, POSE.leftKnee, POSE.rightKnee, POSE.leftShoulder, POSE.rightShoulder]) {
    addRisk(index, 0.18 + uncertainty * 0.45, "rgba(66, 153, 225, 0.45)", 0.055 + uncertainty * 0.045);
  }

  for (const signal of feedback) {
    if (signal.severity === "good") {
      continue;
    }
    const intensity = signal.severity === "fix" ? 0.86 : 0.52;
    const color = signal.severity === "fix" ? "rgba(255, 92, 92, 0.72)" : "rgba(255, 185, 90, 0.62)";
    if (signal.joint === "knees") {
      addRisk(POSE.leftKnee, intensity, color, 0.105);
      addRisk(POSE.rightKnee, intensity, color, 0.105);
    }
    if (signal.joint === "hips") {
      addRisk(POSE.leftHip, intensity, color, 0.12);
      addRisk(POSE.rightHip, intensity, color, 0.12);
    }
    if (signal.joint === "spine") {
      addRisk(POSE.leftShoulder, intensity, color, 0.115);
      addRisk(POSE.rightShoulder, intensity, color, 0.115);
      addRisk(POSE.leftHip, intensity * 0.7, color, 0.095);
      addRisk(POSE.rightHip, intensity * 0.7, color, 0.095);
    }
    if (signal.joint === "shoulders") {
      addRisk(POSE.leftShoulder, intensity, color, 0.105);
      addRisk(POSE.rightShoulder, intensity, color, 0.105);
      addRisk(POSE.leftWrist, intensity * 0.7, color, 0.095);
      addRisk(POSE.rightWrist, intensity * 0.7, color, 0.095);
    }
  }

  return risks.slice(0, 20);
}
