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

type BasicMetrics = {
  hipAngle: number;
  kneeAngle: number;
  torsoLean: number;
  shoulderWidth: number;
  torsoLength: number;
  visibility: number;
};

type RepProgress = "idle" | "backswing" | "drive";

// Fail-closed capture-quality gates; these are not performance or clinical thresholds.
const MIN_CALIBRATION_SAMPLES = 30;
const MIN_CALIBRATION_DURATION_MS = 1500;
const MIN_VALID_CALIBRATION_RATIO = 0.8;
const MIN_CALIBRATION_VISIBILITY = 0.7;
const MIN_UPRIGHT_HIP_ANGLE = 150;
const MIN_UPRIGHT_KNEE_ANGLE = 155;
const MAX_UPRIGHT_TORSO_LEAN = 20;
const MAX_HIP_CALIBRATION_JITTER = 4;
const MAX_KNEE_CALIBRATION_JITTER = 4;
const MAX_TORSO_CALIBRATION_JITTER = 3.5;
const MAX_TRACKING_GAP_MS = 350;
const MAX_REP_DURATION_MS = 3500;
const MIN_TRACKING_VISIBILITY = 0.58;
const MIN_WRIST_VISIBILITY = 0.55;
const MIN_REQUIRED_LANDMARK_VISIBILITY = 0.3;
const MIN_CAMERA_QUALITY = 0.45;
const MIN_RECENT_MOTION_DEGREES = 4;
const MIN_REP_INTERVAL_MS = 650;
const RECENT_MOTION_WINDOW_MS = 750;
const DEPTH_WINDOW_MS = 1200;

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

const trackingIndices = [
  ...calibrationIndices,
  POSE.leftEar,
  POSE.rightEar,
  POSE.leftWrist,
  POSE.rightWrist
];

const requiredFullBodyIndices = [
  ...calibrationIndices,
  POSE.leftWrist,
  POSE.rightWrist
];

export function createCalibrationProfile(samples: PoseFrame[]): CalibrationProfile | null {
  if (samples.length < MIN_CALIBRATION_SAMPLES) {
    return null;
  }

  const measured = samples
    .filter((sample) => Number.isFinite(sample.timestamp) && hasBasicLandmarks(sample.landmarks, sample.worldLandmarks))
    .map((sample) => ({
      timestamp: sample.timestamp,
      metrics: measureBasic(sample.landmarks, sample.worldLandmarks)
    }))
    .filter(
      ({ metrics }) =>
        isFiniteBasicMetrics(metrics) &&
        metrics.visibility >= MIN_CALIBRATION_VISIBILITY &&
        metrics.hipAngle >= MIN_UPRIGHT_HIP_ANGLE &&
        metrics.kneeAngle >= MIN_UPRIGHT_KNEE_ANGLE &&
        metrics.torsoLean <= MAX_UPRIGHT_TORSO_LEAN
    );

  if (
    measured.length < MIN_CALIBRATION_SAMPLES ||
    measured.length / samples.length < MIN_VALID_CALIBRATION_RATIO
  ) {
    return null;
  }

  const timestamps = measured.map(({ timestamp }) => timestamp);
  if (timestamps.some((timestamp, index) => index > 0 && timestamp <= timestamps[index - 1])) {
    return null;
  }
  const duration = Math.max(...timestamps) - Math.min(...timestamps);
  if (duration < MIN_CALIBRATION_DURATION_MS) {
    return null;
  }

  const hipAngles = measured.map(({ metrics }) => metrics.hipAngle);
  const kneeAngles = measured.map(({ metrics }) => metrics.kneeAngle);
  const torsoLeans = measured.map(({ metrics }) => metrics.torsoLean);
  const hipJitter = standardDeviation(hipAngles);
  if (
    hipJitter > MAX_HIP_CALIBRATION_JITTER ||
    standardDeviation(kneeAngles) > MAX_KNEE_CALIBRATION_JITTER ||
    standardDeviation(torsoLeans) > MAX_TORSO_CALIBRATION_JITTER
  ) {
    return null;
  }

  return {
    createdAt: Date.now(),
    sampleCount: measured.length,
    uprightHipAngle: median(hipAngles),
    uprightKneeAngle: median(kneeAngles),
    uprightTorsoLean: median(torsoLeans),
    shoulderWidth: median(measured.map(({ metrics }) => metrics.shoulderWidth)),
    torsoLength: median(measured.map(({ metrics }) => metrics.torsoLength)),
    confidence: clamp(mean(measured.map(({ metrics }) => metrics.visibility)), 0, 1),
    jitter: hipJitter
  };
}

export class SwingAnalyzer {
  private phase: SwingPhase = "waiting";
  private repCount = 0;
  private history: MetricSample[] = [];
  private wristTrail = [] as Array<{ x: number; y: number; z: number }>;
  private repProgress: RepProgress = "idle";
  private repStartedAt = 0;
  private lastFrameAt: number | null = null;
  private lastRepAt = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.phase = "waiting";
    this.repCount = 0;
    this.clearTrackingState();
    this.lastFrameAt = null;
    this.lastRepAt = Number.NEGATIVE_INFINITY;
  }

  update(frame: PoseFrame, settings: CoachSettings, calibration?: CalibrationProfile | null): AnalysisFrame {
    const profile = calibration ?? DEFAULT_PROFILE;
    const now = frame.timestamp;
    const timelineBroken =
      this.lastFrameAt !== null &&
      (!Number.isFinite(now) || now <= this.lastFrameAt || now - this.lastFrameAt > MAX_TRACKING_GAP_MS);

    if (timelineBroken) {
      this.clearTrackingState();
    }
    this.lastFrameAt = Number.isFinite(now) ? now : null;

    if (!Number.isFinite(now) || !hasTrackingLandmarks(frame.landmarks, frame.worldLandmarks)) {
      this.clearTrackingState();
      return createNoAssessmentFrame(frame, this.repCount);
    }

    const metrics = measureSwing(frame.landmarks, frame.worldLandmarks, profile, settings, this.history, now);
    const sample = {
      timestamp: now,
      hipAngle: metrics.hipAngle,
      hipFlexionDelta: metrics.hipFlexionDelta,
      kneeFlexionDelta: metrics.kneeFlexionDelta,
      wristHeight: metrics.wristHeight,
      wristDepth: metrics.wristDepth
    };

    const previous = this.history.at(-1);
    const dt = previous ? Math.max(16, now - previous.timestamp) / 1000 : 1 / 30;
    const hipVelocity = previous ? (sample.hipFlexionDelta - previous.hipFlexionDelta) / dt : 0;
    metrics.repVelocity = Math.abs(hipVelocity);

    const wristVisibility = visibilityOf(frame.landmarks, [POSE.leftWrist, POSE.rightWrist]);
    const fullBodyVisible = requiredFullBodyIndices.every(
      (index) => (frame.landmarks[index]?.visibility ?? 0) >= MIN_REQUIRED_LANDMARK_VISIBILITY
    );
    const trackingReady =
      metrics.visibility >= MIN_TRACKING_VISIBILITY &&
      wristVisibility >= MIN_WRIST_VISIBILITY &&
      fullBodyVisible &&
      metrics.cameraQuality >= MIN_CAMERA_QUALITY;
    if (!trackingReady) {
      this.clearTrackingState();
      return createNoAssessmentFrame(frame, this.repCount, metrics);
    }

    const hasMotion = hasRecentMotion(this.history, sample, hipVelocity);
    this.history.push(sample);
    this.history = this.history.filter((item) => now - item.timestamp < 4500);

    this.wristTrail.push(getWristWorld(frame.worldLandmarks));
    this.wristTrail = this.wristTrail.slice(-90);

    const thresholds = getThresholds(settings);
    this.phase = classifyPhase(metrics, hipVelocity, thresholds, hasMotion);
    const completedRep = this.advanceRepState(this.phase, metrics, now, thresholds);
    const isRecentCompletedRep = Number.isFinite(this.lastRepAt) && now - this.lastRepAt <= 450;
    const shouldAssess =
      this.phase !== "waiting" &&
      (this.repProgress !== "idle" || completedRep || isRecentCompletedRep);
    const feedback = shouldAssess ? buildFeedback(metrics, settings, this.phase, thresholds) : [];
    const jointRisks = shouldAssess ? buildJointRisks(frame.landmarks, metrics, feedback) : [];
    const score = shouldAssess ? scoreFrame(metrics, feedback) : 0;

    return {
      assessmentStatus: shouldAssess ? "assessed" : "unassessed",
      phase: this.phase,
      repCount: this.repCount,
      score,
      confidence: clamp(metrics.visibility * 0.58 + metrics.cameraQuality * 0.42, 0, 1),
      metrics,
      feedback,
      jointRisks,
      worldLandmarks: frame.worldLandmarks,
      landmarks: frame.landmarks,
      wristTrail: [...this.wristTrail]
    };
  }

  private clearTrackingState(): void {
    this.phase = "waiting";
    this.history = [];
    this.wristTrail = [];
    this.repProgress = "idle";
    this.repStartedAt = 0;
  }

  private advanceRepState(
    phase: SwingPhase,
    metrics: SwingMetrics,
    now: number,
    thresholds: { bottom: number; top: number }
  ): boolean {
    if (this.repProgress !== "idle" && now - this.repStartedAt > MAX_REP_DURATION_MS) {
      this.repProgress = "idle";
      this.repStartedAt = 0;
    }

    if (phase === "backswing") {
      if (this.repProgress === "idle" || this.repProgress === "drive") {
        this.repProgress = "backswing";
        this.repStartedAt = now;
      }
      return false;
    }

    if (phase === "drive" && this.repProgress === "backswing") {
      this.repProgress = "drive";
      return false;
    }

    if (phase === "float" || phase === "lockout") {
      const completed =
        this.repProgress === "drive" &&
        metrics.hipFlexionDelta <= thresholds.top &&
        metrics.wristHeight > 0.18 &&
        now - this.lastRepAt > MIN_REP_INTERVAL_MS;

      this.repProgress = "idle";
      this.repStartedAt = 0;
      if (completed) {
        this.repCount += 1;
        this.lastRepAt = now;
      }
      return completed;
    }

    return false;
  }
}

function hasBasicLandmarks(landmarks: NormalizedLandmark[], worldLandmarks: Landmark[]): boolean {
  return calibrationIndices.every(
    (index) => isFiniteImageLandmark(landmarks[index]) && isFiniteWorldLandmark(worldLandmarks[index])
  );
}

function hasTrackingLandmarks(landmarks: NormalizedLandmark[], worldLandmarks: Landmark[]): boolean {
  return trackingIndices.every(
    (index) => isFiniteImageLandmark(landmarks[index]) && isFiniteWorldLandmark(worldLandmarks[index])
  );
}

function isFiniteImageLandmark(landmark: NormalizedLandmark | undefined): landmark is NormalizedLandmark {
  return Boolean(landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y));
}

function isFiniteWorldLandmark(landmark: Landmark | undefined): landmark is Landmark {
  return Boolean(
    landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y) && Number.isFinite(landmark.z)
  );
}

function isFiniteBasicMetrics(metrics: BasicMetrics): boolean {
  return Object.values(metrics).every(Number.isFinite) && metrics.shoulderWidth > 0 && metrics.torsoLength > 0;
}

function createNoAssessmentFrame(
  frame: PoseFrame,
  repCount: number,
  measuredMetrics?: SwingMetrics
): AnalysisFrame {
  const metrics: SwingMetrics = measuredMetrics ?? {
    hipAngle: 0,
    kneeAngle: 0,
    hipFlexionDelta: 0,
    kneeFlexionDelta: 0,
    hingeRatio: 0,
    torsoLean: 0,
    shoulderLift: 0,
    wristHeight: 0,
    wristDepth: 0,
    spineStack: 0,
    visibility: 0,
    cameraQuality: 0,
    smoothness: 0,
    depthTravel: 0,
    repVelocity: 0
  };

  return {
    assessmentStatus: "unassessed",
    phase: "waiting",
    repCount,
    score: 0,
    confidence: clamp(metrics.visibility * 0.58 + metrics.cameraQuality * 0.42, 0, 1),
    metrics,
    feedback: [],
    jointRisks: [],
    worldLandmarks: frame.worldLandmarks,
    landmarks: frame.landmarks,
    wristTrail: []
  };
}

function hasRecentMotion(history: MetricSample[], current: MetricSample, hipVelocity: number): boolean {
  if (Math.abs(hipVelocity) >= 8) {
    return true;
  }

  const recentDeltas = [
    ...history
      .filter((sample) => current.timestamp - sample.timestamp <= RECENT_MOTION_WINDOW_MS)
      .map((sample) => sample.hipFlexionDelta),
    current.hipFlexionDelta
  ];
  if (recentDeltas.length < 2) {
    return false;
  }

  return Math.max(...recentDeltas) - Math.min(...recentDeltas) >= MIN_RECENT_MOTION_DEGREES;
}

function calculateMotionSmoothness(
  history: MetricSample[],
  current: { timestamp: number; hipAngle: number }
): number {
  const recent = [
    ...history
      .filter((sample) => current.timestamp - sample.timestamp <= RECENT_MOTION_WINDOW_MS)
      .map(({ timestamp, hipAngle }) => ({ timestamp, hipAngle })),
    current
  ];
  if (recent.length < 3) {
    return 1;
  }

  const predictionErrors: number[] = [];
  for (let index = 2; index < recent.length; index += 1) {
    const before = recent[index - 2];
    const previous = recent[index - 1];
    const next = recent[index];
    const previousDt = previous.timestamp - before.timestamp;
    const nextDt = next.timestamp - previous.timestamp;
    if (previousDt <= 0 || nextDt <= 0 || previousDt > MAX_TRACKING_GAP_MS || nextDt > MAX_TRACKING_GAP_MS) {
      continue;
    }

    const previousVelocity = (previous.hipAngle - before.hipAngle) / previousDt;
    const predictedAngle = previous.hipAngle + previousVelocity * nextDt;
    predictionErrors.push(Math.abs(next.hipAngle - predictedAngle));
  }

  if (predictionErrors.length === 0) {
    return 1;
  }
  return clamp(1 - median(predictionErrors) / 10, 0.25, 1);
}

function getThresholds(settings: CoachSettings): { bottom: number; top: number; hingeRatio: number } {
  const experienceAdjustment = settings.experience === "new" ? -2 : settings.experience === "advanced" ? 3 : 0;
  const goalBottom = settings.goal === "power" ? 42 : 36;
  const top = settings.experience === "advanced" ? 10 : 14;
  const hingeRatio = settings.experience === "advanced" ? 1.65 : 1.45;
  return {
    bottom: goalBottom + experienceAdjustment,
    top,
    hingeRatio
  };
}

function classifyPhase(
  metrics: SwingMetrics,
  hipVelocity: number,
  thresholds: { bottom: number; top: number },
  hasMotion: boolean
): SwingPhase {
  if (!hasMotion) {
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

function measureBasic(landmarks: NormalizedLandmark[], worldLandmarks: Landmark[]): BasicMetrics {
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
  history: MetricSample[],
  now: number
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
  const recentDepths = [
    ...history.filter((item) => now - item.timestamp <= DEPTH_WINDOW_MS).map((item) => item.wristDepth),
    wristWorld.z
  ];
  const depthTravel = recentDepths.length > 2 ? Math.max(...recentDepths) - Math.min(...recentDepths) : 0;
  const smoothness = calculateMotionSmoothness(history, { timestamp: now, hipAngle: basic.hipAngle });

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
    visibility: visibilityOf(landmarks, trackingIndices),
    cameraQuality,
    smoothness,
    depthTravel: normalizeDepthTravel(depthTravel, profile, settings),
    repVelocity: 0
  };
}

function normalizeDepthTravel(depthTravel: number, profile: CalibrationProfile, settings: CoachSettings): number {
  const estimatedTorso = Math.max(0.35, profile.torsoLength);
  const heightCm = Number.isFinite(settings.heightCm) ? settings.heightCm : 175;
  const heightScale = clamp(heightCm / 175, 0.82, 1.18);
  return clamp(depthTravel / (estimatedTorso * 0.55 * heightScale), 0, 1.4);
}

function getWristWorld(worldLandmarks: Landmark[]) {
  return midpoint3(asVec3(worldLandmarks[POSE.leftWrist]), asVec3(worldLandmarks[POSE.rightWrist]));
}

function buildFeedback(
  metrics: SwingMetrics,
  settings: CoachSettings,
  phase: SwingPhase,
  thresholds: { hingeRatio: number }
): FeedbackSignal[] {
  const feedback: FeedbackSignal[] = [];
  const add = (signal: FeedbackSignal) => feedback.push(signal);

  if (metrics.cameraQuality < 0.62) {
    add({
      id: "camera",
      label: "Use a cleaner side view",
      detail: "A side-on camera angle makes shoulder, hip, knee, and wrist landmarks more reliable.",
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

  if ((phase === "float" || phase === "lockout") && metrics.shoulderLift > 0.055) {
    add({
      id: "arm-lift",
      label: "Let your hands float",
      detail: "Hands are rising above shoulder level; reduce shoulder pull and let hip drive set their height.",
      severity: metrics.shoulderLift > 0.1 || settings.bellKg > 24 ? "fix" : "watch",
      score: clamp(1 - metrics.shoulderLift / 0.18, 0, 1),
      joint: "shoulders"
    });
  }

  if ((phase === "float" || phase === "lockout") && metrics.spineStack < 0.68) {
    add({
      id: "spine-stack",
      label: "Stack ribs over hips",
      detail: "Avoid craning the neck or leaning back as your hands reach the top.",
      severity: metrics.spineStack < 0.45 ? "fix" : "watch",
      score: metrics.spineStack,
      joint: "spine"
    });
  }

  if (feedback.length === 0) {
    if (phase === "backswing" || phase === "drive") {
      add({
        id: "rep-progress",
        label: "Rep in progress",
        detail: "Complete the swing before the coach reports a finished-rep assessment.",
        severity: "good",
        score: 1
      });
    } else {
      add({
        id: "rep-complete",
        label: "Rep completed",
        detail: "No additional high-confidence adjustment is available for this finish.",
        severity: "good",
        score: 1
      });
    }
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
    metrics.spineStack * 25 +
    clamp(metrics.hingeRatio / 1.8, 0, 1) * 25 +
    clamp(1 - metrics.shoulderLift / 0.14, 0, 1) * 20 +
    metrics.smoothness * 10 +
    20;
  return Math.round(clamp(movementScore - penalty - confidencePenalty, 0, 100));
}

function buildJointRisks(
  landmarks: NormalizedLandmark[],
  metrics: SwingMetrics,
  feedback: FeedbackSignal[]
): JointRisk[] {
  const risks = new Map<number, { risk: JointRisk; priority: number }>();
  const addRisk = (index: number, intensity: number, color: string, radius = 0.07, priority = 0) => {
    const landmark = landmarks[index];
    if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) {
      return;
    }

    const risk = {
      index,
      center: asVec2(landmark),
      depth: Number.isFinite(landmark.z) ? landmark.z : 0,
      radius,
      intensity: clamp(intensity, 0, 1),
      color
    };
    const current = risks.get(index);
    if (
      !current ||
      priority > current.priority ||
      (priority === current.priority && risk.intensity > current.risk.intensity)
    ) {
      risks.set(index, { risk, priority });
    }
  };

  const uncertainty = clamp(1 - metrics.visibility, 0, 1);
  for (const index of [POSE.leftHip, POSE.rightHip, POSE.leftKnee, POSE.rightKnee, POSE.leftShoulder, POSE.rightShoulder]) {
    addRisk(index, 0.18 + uncertainty * 0.45, "rgba(66, 153, 225, 0.45)", 0.055 + uncertainty * 0.045, 0);
  }

  for (const signal of feedback) {
    if (signal.severity === "good") {
      continue;
    }
    const intensity = signal.severity === "fix" ? 0.86 : 0.52;
    const priority = signal.severity === "fix" ? 2 : 1;
    const color = signal.severity === "fix" ? "rgba(255, 92, 92, 0.72)" : "rgba(255, 185, 90, 0.62)";
    if (signal.joint === "knees") {
      addRisk(POSE.leftKnee, intensity, color, 0.105, priority);
      addRisk(POSE.rightKnee, intensity, color, 0.105, priority);
    }
    if (signal.joint === "hips") {
      addRisk(POSE.leftHip, intensity, color, 0.12, priority);
      addRisk(POSE.rightHip, intensity, color, 0.12, priority);
    }
    if (signal.joint === "spine") {
      addRisk(POSE.leftShoulder, intensity, color, 0.115, priority);
      addRisk(POSE.rightShoulder, intensity, color, 0.115, priority);
      addRisk(POSE.leftHip, intensity * 0.7, color, 0.095, priority);
      addRisk(POSE.rightHip, intensity * 0.7, color, 0.095, priority);
    }
    if (signal.joint === "shoulders") {
      addRisk(POSE.leftShoulder, intensity, color, 0.105, priority);
      addRisk(POSE.rightShoulder, intensity, color, 0.105, priority);
      addRisk(POSE.leftWrist, intensity * 0.7, color, 0.095, priority);
      addRisk(POSE.rightWrist, intensity * 0.7, color, 0.095, priority);
    }
  }

  return [...risks.values()].map(({ risk }) => risk).slice(0, 20);
}
