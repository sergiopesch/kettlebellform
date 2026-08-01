import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import { getFramingCue } from "../framingCoach";
import { POSE } from "../landmarks";

function pose({ centerX = 0.5, top = 0.1, bottom = 0.86, shoulderWidth = 0.1 } = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({
    x: centerX,
    y: 0.5,
    z: 0,
    visibility: 0.95
  })) as NormalizedLandmark[];
  landmarks[POSE.nose].y = top;
  landmarks[POSE.leftEar].y = top + 0.01;
  landmarks[POSE.rightEar].y = top + 0.01;
  landmarks[POSE.leftShoulder].x = centerX - shoulderWidth / 2;
  landmarks[POSE.rightShoulder].x = centerX + shoulderWidth / 2;
  landmarks[POSE.leftShoulder].y = 0.28;
  landmarks[POSE.rightShoulder].y = 0.28;
  landmarks[POSE.leftHip].x = centerX - 0.025;
  landmarks[POSE.rightHip].x = centerX + 0.025;
  landmarks[POSE.leftHip].y = 0.52;
  landmarks[POSE.rightHip].y = 0.52;
  landmarks[POSE.leftWrist].x = centerX - 0.08;
  landmarks[POSE.rightWrist].x = centerX - 0.07;
  landmarks[POSE.leftWrist].y = 0.58;
  landmarks[POSE.rightWrist].y = 0.58;
  for (const index of [
    POSE.leftAnkle,
    POSE.rightAnkle,
    POSE.leftHeel,
    POSE.rightHeel,
    POSE.leftFootIndex,
    POSE.rightFootIndex
  ]) {
    landmarks[index].y = bottom;
  }
  return landmarks;
}

describe("getFramingCue", () => {
  it("asks the user to enter view without a complete pose", () => {
    expect(getFramingCue(null).id).toBe("finding");
    expect(getFramingCue(pose().slice(0, 12)).id).toBe("finding");
  });

  it("uses the mirrored preview when giving horizontal directions", () => {
    expect(getFramingCue(pose({ centerX: 0.72 })).id).toBe("move-right");
    expect(getFramingCue(pose({ centerX: 0.28 })).id).toBe("move-left");
  });

  it("can give directions against an unmirrored preview", () => {
    expect(getFramingCue(pose({ centerX: 0.28 }), { mirrored: false }).id).toBe("move-right");
    expect(getFramingCue(pose({ centerX: 0.72 }), { mirrored: false }).id).toBe("move-left");
  });

  it("asks for more room when the full pose touches an edge", () => {
    expect(getFramingCue(pose({ top: 0.025 })).id).toBe("step-back");
    expect(getFramingCue(pose({ bottom: 0.98 })).id).toBe("step-back");

    const clippedWrist = pose();
    clippedWrist[POSE.rightWrist].x = 0.02;
    expect(getFramingCue(clippedWrist).id).toBe("step-back");

    const clippedToe = pose();
    clippedToe[POSE.rightFootIndex].x = 0.99;
    expect(getFramingCue(clippedToe).id).toBe("step-back");
  });

  it("asks the user to move closer when the pose is too small", () => {
    expect(getFramingCue(pose({ top: 0.28, bottom: 0.66 })).id).toBe("move-closer");
  });

  it("asks for a side view before declaring the position ready", () => {
    expect(getFramingCue(pose({ shoulderWidth: 0.3 })).id).toBe("turn-side-on");
    expect(getFramingCue(pose()).id).toBe("ready");
    expect(getFramingCue(pose({ shoulderWidth: 0.3 }), { requireSideView: false }).id).toBe("ready");
  });

  it("keeps side-view readiness stable across portrait and landscape optics", () => {
    const landscape = pose({ shoulderWidth: 0.14 });
    const portrait = pose({ shoulderWidth: 0.25 });

    expect(getFramingCue(landscape, { aspectRatio: 4 / 3 }).id).toBe("ready");
    expect(getFramingCue(portrait, { aspectRatio: 3 / 4 }).id).toBe("ready");

    expect(getFramingCue(pose({ shoulderWidth: 0.18 }), { aspectRatio: 4 / 3 }).id)
      .toBe("turn-side-on");
    expect(getFramingCue(pose({ shoulderWidth: 0.32 }), { aspectRatio: 3 / 4 }).id)
      .toBe("turn-side-on");
  });

  it("fails closed when key framing landmarks are not visible", () => {
    const landmarks = pose();
    landmarks[POSE.leftWrist].visibility = 0.1;
    expect(getFramingCue(landmarks).id).toBe("adjust-frame");

    const missingFoot = pose();
    for (const index of [POSE.rightAnkle, POSE.rightHeel, POSE.rightFootIndex]) {
      missingFoot[index].visibility = 0.1;
    }
    expect(getFramingCue(missingFoot).id).toBe("adjust-frame");

    const missingBothWrists = pose();
    for (const index of [POSE.leftWrist, POSE.rightWrist]) {
      missingBothWrists[index].visibility = 0.1;
    }
    expect(getFramingCue(missingBothWrists).id).toBe("adjust-frame");

    const uncertainOrientation = pose();
    uncertainOrientation[POSE.leftShoulder].visibility = 0.1;
    expect(getFramingCue(uncertainOrientation).id).toBe("adjust-frame");
  });

  it.each([
    ["both knees", [POSE.leftKnee, POSE.rightKnee]],
    ["one hip", [POSE.rightHip]]
  ])("does not declare readiness without %s", (_label, hiddenIndices) => {
    const landmarks = pose();
    for (const index of hiddenIndices) {
      landmarks[index].visibility = 0.1;
    }

    expect(getFramingCue(landmarks).id).toBe("adjust-frame");
  });
});
