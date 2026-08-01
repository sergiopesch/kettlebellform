import { describe, expect, it } from "vitest";
import {
  buildClipAnalysisSummary,
  CLIP_SUMMARY_THRESHOLDS,
  type ClipAnalysisFrame,
  type ClipFrameFeedback
} from "../clipAnalysis";

const goodFeedback: ClipFrameFeedback = {
  id: "rep-complete",
  label: "Rep completed",
  detail: "No additional high-confidence adjustment is available for this finish.",
  severity: "good"
};

const hingeFeedback: ClipFrameFeedback = {
  id: "hinge-ratio",
  label: "Hinge more than you squat",
  detail: "Push the hips back and keep knee bend secondary.",
  severity: "watch",
  score: 0.6,
  joint: "knees"
};

function makeFrame(overrides: Partial<ClipAnalysisFrame> = {}): ClipAnalysisFrame {
  return {
    assessmentStatus: "assessed",
    phase: "lockout",
    repCount: 1,
    confidence: 0.82,
    feedback: [goodFeedback],
    ...overrides
  };
}

function makeFrames(count: number, overrides: Partial<ClipAnalysisFrame> = {}): ClipAnalysisFrame[] {
  return Array.from({ length: count }, () => makeFrame(overrides));
}

function makeThreeRepFrames(feedback: readonly ClipFrameFeedback[] = [goodFeedback]): ClipAnalysisFrame[] {
  return [
    ...makeFrames(4, { phase: "backswing", repCount: 0, feedback }),
    ...makeFrames(4, { phase: "drive", repCount: 1, feedback }),
    ...makeFrames(4, { phase: "lockout", repCount: 3, feedback })
  ];
}

describe("buildClipAnalysisSummary", () => {
  it("fails closed when no frames were decoded", () => {
    const summary = buildClipAnalysisSummary([]);

    expect(summary).toMatchObject({
      status: "unassessed",
      repCount: 0,
      analyzedFrames: 0,
      supportedFrames: 0,
      averageConfidence: 0,
      primaryCue: null
    });
    expect(summary.signals).toEqual([
      expect.objectContaining({ status: "waiting", detail: expect.stringMatching(/no video frames/i) })
    ]);
  });

  it("counts processed frames without treating frames lacking a finite pose as supported", () => {
    const summary = buildClipAnalysisSummary(makeFrames(3), 30);

    expect(summary.analyzedFrames).toBe(30);
    expect(summary.supportedFrames).toBe(3);
    expect(summary.supportedFrameRatio).toBe(0.1);
  });

  it("requires the centralized minimum number of decoded frames", () => {
    const frames = makeFrames(CLIP_SUMMARY_THRESHOLDS.minimumAnalyzedFrames - 1);
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("unassessed");
    expect(summary.reason).toMatch(/enough decoded frames/i);
  });

  it("requires three complete ordered reps even when frame confidence is high", () => {
    const frames = makeFrames(12, { phase: "drive", repCount: 0, feedback: [hingeFeedback] });
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("unassessed");
    expect(summary.repCount).toBe(0);
    expect(summary.reason).toMatch(/at least 3 complete backswing, drive, and finish/i);
  });

  it("fails closed with only two completed reps despite otherwise sufficient evidence", () => {
    const summary = buildClipAnalysisSummary(makeFrames(12, { repCount: 2 }));

    expect(summary.status).toBe("unassessed");
    expect(summary.repCount).toBe(2);
    expect(summary.reason).toMatch(/at least 3 complete/i);
  });

  it("requires at least twelve high-confidence assessed frames", () => {
    const frames = [
      ...makeFrames(CLIP_SUMMARY_THRESHOLDS.minimumSupportedFrames - 1, { repCount: 3 }),
      ...makeFrames(9, { assessmentStatus: "unassessed", repCount: 3, confidence: 0.95, feedback: [] })
    ];
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("unassessed");
    expect(summary.supportedFrames).toBe(11);
    expect(summary.reason).toMatch(/too few frames/i);
  });

  it("rejects sparse evidence even when the absolute supported-frame minimum is met", () => {
    const frames = [
      ...makeFrames(CLIP_SUMMARY_THRESHOLDS.minimumSupportedFrames, { repCount: 3 }),
      ...makeFrames(49, { assessmentStatus: "unassessed", repCount: 3, confidence: 0.2, feedback: [] })
    ];
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("unassessed");
    expect(summary.supportedFrameRatio).toBe(0.197);
    expect(summary.reason).toMatch(/not assessable for enough/i);
  });

  it("assesses at the exact three-rep, twelve-frame, and twenty-percent boundaries", () => {
    const summary = buildClipAnalysisSummary(makeThreeRepFrames(), 60);

    expect(summary).toMatchObject({
      status: "assessed",
      repCount: 3,
      analyzedFrames: 60,
      supportedFrames: 12,
      supportedFrameRatio: 0.2
    });
  });

  it("uses only supported frames for a bounded average confidence", () => {
    const frames = [
      ...makeFrames(11, { repCount: 3, confidence: 0.75 }),
      ...makeFrames(5, { assessmentStatus: "unassessed", repCount: 3, confidence: 0.99, feedback: [] }),
      makeFrame({ repCount: 3, confidence: Number.NaN }),
      makeFrame({ repCount: 3, confidence: 4 })
    ];
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("assessed");
    expect(summary.supportedFrames).toBe(12);
    expect(summary.averageConfidence).toBe(0.771);
  });

  it("returns a cautious positive result when no recurring adjustment is present", () => {
    const summary = buildClipAnalysisSummary(makeThreeRepFrames());

    expect(summary.status).toBe("assessed");
    expect(summary.primaryCue).toEqual(expect.objectContaining({
      title: "No repeatable adjustment identified",
      detail: expect.stringMatching(/not a safety verdict/i)
    }));
    expect(summary.signals).toEqual([
      expect.objectContaining({ label: "Observed swings", status: "good" })
    ]);
  });

  it("surfaces a pointer that recurs in at least half of three supported reps", () => {
    const frames = makeThreeRepFrames([hingeFeedback]);

    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("assessed");
    expect(summary.repCount).toBe(3);
    expect(summary.primaryCue).toEqual({
      title: "Hinge more than you squat",
      detail: "Push the hips back and keep knee bend secondary."
    });
    expect(summary.signals).toEqual([
      {
        label: "Hinge more than you squat",
        detail: "Push the hips back and keep knee bend secondary.",
        status: "watch"
      }
    ]);
  });

  it("requires an adjustment to recur across at least half of multi-rep evidence", () => {
    const frames = [
      ...makeFrames(4, { phase: "backswing", repCount: 0, feedback: [hingeFeedback] }),
      makeFrame({ phase: "lockout", repCount: 1 }),
      ...makeFrames(4, { phase: "backswing", repCount: 1, feedback: [goodFeedback] }),
      makeFrame({ phase: "lockout", repCount: 2 }),
      ...makeFrames(4, { phase: "backswing", repCount: 2, feedback: [goodFeedback] }),
      makeFrame({ phase: "lockout", repCount: 3 })
    ];
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("assessed");
    expect(summary.repCount).toBe(3);
    expect(summary.signals).toEqual([expect.objectContaining({ status: "good" })]);
  });

  it("groups pre-finish and finish observations into the correct completed reps", () => {
    const frames = [
      ...makeFrames(3, { phase: "backswing", repCount: 0, feedback: [hingeFeedback] }),
      makeFrame({ phase: "lockout", repCount: 1, feedback: [hingeFeedback] }),
      ...makeFrames(3, { phase: "drive", repCount: 1, feedback: [hingeFeedback] }),
      makeFrame({ phase: "float", repCount: 2, feedback: [hingeFeedback] }),
      ...makeFrames(3, { phase: "drive", repCount: 2, feedback: [goodFeedback] }),
      makeFrame({ phase: "lockout", repCount: 3, feedback: [goodFeedback] })
    ];
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("assessed");
    expect(summary.repCount).toBe(3);
    expect(summary.primaryCue?.title).toBe("Hinge more than you squat");
  });

  it("drops pointers that occur only in an incomplete final rep", () => {
    const frames = [
      ...makeFrames(3, { phase: "backswing", repCount: 0, feedback: [goodFeedback] }),
      makeFrame({ phase: "lockout", repCount: 1 }),
      ...makeFrames(3, { phase: "backswing", repCount: 1, feedback: [goodFeedback] }),
      makeFrame({ phase: "lockout", repCount: 2 }),
      ...makeFrames(3, { phase: "backswing", repCount: 2, feedback: [goodFeedback] }),
      makeFrame({ phase: "lockout", repCount: 3 }),
      ...makeFrames(3, { phase: "drive", repCount: 3, feedback: [hingeFeedback] })
    ];
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.status).toBe("assessed");
    expect(summary.signals).toEqual([expect.objectContaining({ status: "good" })]);
  });

  it("ranks fix cues before watch cues and keeps the strongest detail", () => {
    const armWatch: ClipFrameFeedback = {
      id: "arm-lift",
      label: "Let the bell float",
      detail: "Relax the shoulders.",
      severity: "watch",
      score: 0.7
    };
    const armFix: ClipFrameFeedback = {
      ...armWatch,
      detail: "Reduce shoulder pull and let hip drive set the height.",
      severity: "fix",
      score: 0.35
    };
    const frames = makeThreeRepFrames([hingeFeedback, armWatch]);
    frames[4] = makeFrame({ feedback: [hingeFeedback, armFix] });

    const summary = buildClipAnalysisSummary(frames);

    expect(summary.primaryCue).toEqual({
      title: "Let the bell float",
      detail: "Reduce shoulder pull and let hip drive set the height."
    });
    expect(summary.signals.map((signal) => signal.label)).toEqual([
      "Let the bell float",
      "Hinge more than you squat"
    ]);
  });

  it("limits cues to three and sorts equivalent evidence deterministically", () => {
    const issues: ClipFrameFeedback[] = ["Delta", "Alpha", "Charlie", "Bravo"].map((label) => ({
      id: label.toLocaleLowerCase(),
      label,
      detail: `${label} detail`,
      severity: "watch",
      score: 0.5
    }));
    const frames = makeThreeRepFrames(issues);
    const summary = buildClipAnalysisSummary(frames);

    expect(summary.signals).toHaveLength(CLIP_SUMMARY_THRESHOLDS.maximumSignals);
    expect(summary.signals.map((signal) => signal.label)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("does not mutate caller-owned frame or feedback arrays", () => {
    const feedback = Object.freeze([hingeFeedback]);
    const frames = Object.freeze(makeThreeRepFrames(feedback));

    expect(() => buildClipAnalysisSummary(frames)).not.toThrow();
    expect(frames[0].feedback).toBe(feedback);
  });
});
