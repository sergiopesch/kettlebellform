import { describe, expect, it } from "vitest";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { CoachSettings, PoseFrame } from "../../types";
import { POSE } from "../landmarks";
import { createCalibrationProfile, SwingAnalyzer } from "../swingAnalyzer";

const settings: CoachSettings = {
  heightCm: 178,
  bellKg: 16,
  experience: "trained",
  goal: "technique",
  sideView: true
};

type FrameOptions = {
  hipAngle?: number;
  kneeAngle?: number;
  visibility?: number;
  wristVisibility?: number;
  wristY?: number;
  wristZ?: number;
};

function makeFrame(timestamp: number, options: FrameOptions = {}): PoseFrame {
  const hipAngle = options.hipAngle ?? 168;
  const kneeAngle = options.kneeAngle ?? 174;
  const visibility = options.visibility ?? 1;
  const wristVisibility = options.wristVisibility ?? visibility;
  const wristY = options.wristY ?? 0.65;
  const wristZ = options.wristZ ?? 0;
  const landmarks: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility
  }));
  const worldLandmarks: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility
  }));

  const setImage = (index: number, x: number, y: number, z = 0, pointVisibility = visibility) => {
    landmarks[index] = { x, y, z, visibility: pointVisibility };
  };
  const setWorld = (index: number, x: number, y: number, z = 0, pointVisibility = visibility) => {
    worldLandmarks[index] = { x, y, z, visibility: pointVisibility };
  };

  setImage(POSE.leftEar, 0.49, 0.1);
  setImage(POSE.rightEar, 0.51, 0.1);
  setImage(POSE.leftShoulder, 0.49, 0.25);
  setImage(POSE.rightShoulder, 0.51, 0.25);
  setImage(POSE.leftHip, 0.49, 0.55);
  setImage(POSE.rightHip, 0.51, 0.55);
  setImage(POSE.leftKnee, 0.49, 0.72);
  setImage(POSE.rightKnee, 0.51, 0.72);
  setImage(POSE.leftAnkle, 0.49, 0.9);
  setImage(POSE.rightAnkle, 0.51, 0.9);
  setImage(POSE.leftWrist, 0.49, wristY, 0, wristVisibility);
  setImage(POSE.rightWrist, 0.51, wristY, 0, wristVisibility);

  const hipRadians = (hipAngle * Math.PI) / 180;
  const shoulderOffsetX = Math.sin(hipRadians);
  const shoulderOffsetY = Math.cos(hipRadians);
  const kneeRadians = (kneeAngle * Math.PI) / 180;
  const ankleOffsetX = Math.sin(kneeRadians);
  const ankleOffsetY = -Math.cos(kneeRadians);

  setWorld(POSE.leftHip, -0.02, 0);
  setWorld(POSE.rightHip, 0.02, 0);
  setWorld(POSE.leftKnee, -0.02, 1);
  setWorld(POSE.rightKnee, 0.02, 1);
  setWorld(POSE.leftAnkle, -0.02 + ankleOffsetX, 1 + ankleOffsetY);
  setWorld(POSE.rightAnkle, 0.02 + ankleOffsetX, 1 + ankleOffsetY);
  setWorld(POSE.leftShoulder, -0.02 + shoulderOffsetX, shoulderOffsetY);
  setWorld(POSE.rightShoulder, 0.02 + shoulderOffsetX, shoulderOffsetY);
  setWorld(POSE.leftEar, -0.02 + shoulderOffsetX, shoulderOffsetY - 0.25);
  setWorld(POSE.rightEar, 0.02 + shoulderOffsetX, shoulderOffsetY - 0.25);
  setWorld(POSE.leftWrist, -0.02, wristY, wristZ, wristVisibility);
  setWorld(POSE.rightWrist, 0.02, wristY, wristZ, wristVisibility);

  return { timestamp, landmarks, worldLandmarks };
}

function makeCalibrationFrames(
  count: number,
  intervalMs: number,
  optionsAt: (index: number) => FrameOptions = () => ({})
): PoseFrame[] {
  return Array.from({ length: count }, (_, index) => makeFrame(index * intervalMs, optionsAt(index)));
}

function runValidRep(analyzer: SwingAnalyzer, startAt = 1000) {
  analyzer.update(makeFrame(startAt, { hipAngle: 168, kneeAngle: 174, wristY: 0.65 }), settings);
  analyzer.update(makeFrame(startAt + 100, { hipAngle: 150, kneeAngle: 160, wristY: 0.65 }), settings);
  const backswing = analyzer.update(
    makeFrame(startAt + 200, { hipAngle: 120, kneeAngle: 150, wristY: 0.65 }),
    settings
  );
  const drive = analyzer.update(
    makeFrame(startAt + 300, { hipAngle: 145, kneeAngle: 150, wristY: 0.5 }),
    settings
  );
  const top = analyzer.update(
    makeFrame(startAt + 400, { hipAngle: 168, kneeAngle: 174, wristY: 0.3 }),
    settings
  );
  return { backswing, drive, top };
}

describe("createCalibrationProfile", () => {
  it("accepts enough stable upright samples spanning the minimum time", () => {
    const profile = createCalibrationProfile(makeCalibrationFrames(36, 50));

    expect(profile).not.toBeNull();
    expect(profile?.sampleCount).toBe(36);
    expect(profile?.uprightHipAngle).toBeCloseTo(168, 3);
    expect(profile?.uprightKneeAngle).toBeCloseTo(174, 3);
    expect(profile?.jitter).toBeLessThan(0.001);
  });

  it("rejects too few samples or an inadequate time span", () => {
    expect(createCalibrationProfile(makeCalibrationFrames(29, 100))).toBeNull();
    expect(createCalibrationProfile(makeCalibrationFrames(36, 20))).toBeNull();
  });

  it("rejects a stable but bent calibration posture", () => {
    const frames = makeCalibrationFrames(36, 50, () => ({ hipAngle: 120, kneeAngle: 174 }));

    expect(createCalibrationProfile(frames)).toBeNull();
  });

  it("rejects unstable upright samples", () => {
    const frames = makeCalibrationFrames(36, 50, (index) => ({
      hipAngle: index % 2 === 0 ? 152 : 178,
      kneeAngle: index % 2 === 0 ? 158 : 178
    }));

    expect(createCalibrationProfile(frames)).toBeNull();
  });
});

describe("SwingAnalyzer tracking continuity", () => {
  it("returns an unassessed waiting frame for motionless input", () => {
    const analyzer = new SwingAnalyzer();
    analyzer.update(makeFrame(1000), settings);
    const result = analyzer.update(makeFrame(1100), settings);

    expect(result.phase).toBe("waiting");
    expect(result.assessmentStatus).toBe("unassessed");
    expect(result.repCount).toBe(0);
    expect(result.score).toBe(0);
    expect(result.feedback).toEqual([]);
    expect(result.jointRisks).toEqual([]);
  });

  it("counts only an ordered backswing to drive to top sequence", () => {
    const analyzer = new SwingAnalyzer();
    const { backswing, drive, top } = runValidRep(analyzer);

    expect(backswing.phase).toBe("backswing");
    expect(drive.phase).toBe("drive");
    expect(top.phase).toBe("lockout");
    expect(backswing.assessmentStatus).toBe("assessed");
    expect(drive.assessmentStatus).toBe("assessed");
    expect(top.assessmentStatus).toBe("assessed");
    expect(top.repCount).toBe(1);
    expect(top.feedback.some((signal) => signal.id === "rep-complete")).toBe(true);
  });

  it("does not count a backswing that skips the drive phase", () => {
    const analyzer = new SwingAnalyzer();
    analyzer.update(makeFrame(1000), settings);
    analyzer.update(makeFrame(1100, { hipAngle: 150 }), settings);
    analyzer.update(makeFrame(1200, { hipAngle: 120 }), settings);
    const top = analyzer.update(makeFrame(1300, { hipAngle: 168, wristY: 0.3 }), settings);

    expect(top.repCount).toBe(0);
    expect(top.score).toBe(0);
    expect(top.feedback).toEqual([]);
  });

  it("clears an in-flight rep after a large frame gap", () => {
    const analyzer = new SwingAnalyzer();
    analyzer.update(makeFrame(1000), settings);
    analyzer.update(makeFrame(1100, { hipAngle: 150 }), settings);
    analyzer.update(makeFrame(1200, { hipAngle: 120 }), settings);
    analyzer.update(makeFrame(1700, { hipAngle: 145 }), settings);
    const top = analyzer.update(makeFrame(1800, { hipAngle: 168, wristY: 0.3 }), settings);

    expect(top.repCount).toBe(0);
  });

  it("clears an in-flight rep after low-confidence wrist input", () => {
    const analyzer = new SwingAnalyzer();
    analyzer.update(makeFrame(1000), settings);
    analyzer.update(makeFrame(1100, { hipAngle: 150 }), settings);
    const lost = analyzer.update(makeFrame(1200, { hipAngle: 120, wristVisibility: 0.1 }), settings);
    analyzer.update(makeFrame(1300, { hipAngle: 145 }), settings);
    const top = analyzer.update(makeFrame(1400, { hipAngle: 168, wristY: 0.3 }), settings);

    expect(lost.phase).toBe("waiting");
    expect(lost.score).toBe(0);
    expect(lost.feedback).toEqual([]);
    expect(lost.jointRisks).toEqual([]);
    expect(top.repCount).toBe(0);
  });

  it("preserves completed session reps while resetting tracking after a gap", () => {
    const analyzer = new SwingAnalyzer();
    expect(runValidRep(analyzer).top.repCount).toBe(1);

    const afterGap = analyzer.update(makeFrame(2500), settings);

    expect(afterGap.repCount).toBe(1);
    expect(afterGap.phase).toBe("waiting");
    expect(afterGap.score).toBe(0);
  });

  it("returns a neutral frame rather than throwing for a truncated pose", () => {
    const analyzer = new SwingAnalyzer();
    const result = analyzer.update(
      { timestamp: 1000, landmarks: [], worldLandmarks: [] },
      settings
    );

    expect(result.phase).toBe("waiting");
    expect(result.score).toBe(0);
    expect(result.feedback).toEqual([]);
  });
});

describe("SwingAnalyzer assessment signals", () => {
  it("deduplicates a joint risk and retains the highest feedback severity", () => {
    const analyzer = new SwingAnalyzer();
    analyzer.update(makeFrame(1000), settings);
    analyzer.update(makeFrame(1100, { hipAngle: 150, kneeAngle: 160 }), settings);
    const backswing = analyzer.update(
      makeFrame(1200, { hipAngle: 120, kneeAngle: 110 }),
      settings
    );
    const leftKneeRisks = backswing.jointRisks.filter(({ index }) => index === POSE.leftKnee);

    expect(backswing.feedback.some((signal) => signal.id === "hinge-ratio" && signal.severity === "fix")).toBe(true);
    expect(leftKneeRisks).toHaveLength(1);
    expect(leftKneeRisks[0].intensity).toBeCloseTo(0.86);
    expect(leftKneeRisks[0].color).toContain("255, 92, 92");
  });

  it("does not emit the removed depth or unreachable lockout feedback", () => {
    const analyzer = new SwingAnalyzer();
    const frames = Object.values(runValidRep(analyzer));
    const feedbackIds = frames.flatMap(({ feedback }) => feedback.map(({ id }) => id));

    expect(feedbackIds).not.toContain("hinge-depth");
    expect(feedbackIds).not.toContain("depth-path");
    expect(feedbackIds).not.toContain("finish-hips");
  });

  it("does not mistake a smooth range of motion for tracking roughness", () => {
    const analyzer = new SwingAnalyzer();
    analyzer.update(makeFrame(1000, { hipAngle: 168 }), settings);
    analyzer.update(makeFrame(1100, { hipAngle: 156 }), settings);
    const third = analyzer.update(makeFrame(1200, { hipAngle: 144 }), settings);

    expect(third.metrics.smoothness).toBeCloseTo(1, 5);
  });
});
