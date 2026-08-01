export const CLIP_SUMMARY_THRESHOLDS = Object.freeze({
  minimumAnalyzedFrames: 8,
  minimumCompletedReps: 3,
  minimumSupportedFrames: 12,
  minimumSupportedFrameRatio: 0.2,
  minimumFrameConfidence: 0.62,
  maximumSignals: 3
});

export type ClipAnalysisStatus = "assessed" | "unassessed";
export type ClipSummarySignalStatus = "good" | "watch" | "waiting";

export type ClipFrameFeedback = {
  id?: string;
  label: string;
  detail: string;
  severity: "good" | "watch" | "fix";
  score?: number;
  joint?: string;
};

/**
 * The smallest structural subset of AnalysisFrame needed for clip aggregation.
 * AnalysisFrame values can be passed directly without coupling this module to
 * the live-session types.
 */
export type ClipAnalysisFrame = {
  assessmentStatus: ClipAnalysisStatus;
  phase?: "waiting" | "backswing" | "drive" | "float" | "lockout";
  repCount: number;
  confidence: number;
  feedback: readonly ClipFrameFeedback[];
};

export type ClipSummarySignal = {
  label: string;
  detail: string;
  status: ClipSummarySignalStatus;
};

export type ClipAnalysisSummary = {
  status: ClipAnalysisStatus;
  repCount: number;
  analyzedFrames: number;
  supportedFrames: number;
  averageConfidence: number;
  primaryCue: { title: string; detail: string } | null;
  signals: ClipSummarySignal[];
  supportedFrameRatio: number;
  reason: string | null;
};

type CueObservation = {
  key: string;
  label: string;
  detail: string;
  severity: "watch" | "fix";
  severityRank: number;
  representativeScore: number;
  confidenceTotal: number;
  occurrences: number;
  reps: Set<number>;
};

const UNASSESSED_REASONS = Object.freeze({
  noFrames: "No video frames were available for analysis.",
  tooFewFrames: "The selected clip did not contain enough decoded frames for a reliable assessment.",
  tooFewCompleteReps: "At least 3 complete backswing, drive, and finish sequences are required for a clip assessment.",
  tooLittleSupport: "Too few frames met the pose visibility and view-quality requirements.",
  tooLittleCoverage: "The athlete was not assessable for enough of the selected clip. Adjust the crop or choose another section."
});

/**
 * Aggregates frame-level observations into conservative, rep-level clip cues.
 * A clip remains unassessed unless it contains at least three completed reps and enough
 * high-confidence evidence. Technique cues must recur across completed reps;
 * isolated observations from an incomplete final rep are discarded.
 */
export function buildClipAnalysisSummary(
  frames: readonly ClipAnalysisFrame[],
  totalProcessedFrames: number = frames.length
): ClipAnalysisSummary {
  const analyzedFrames = Number.isFinite(totalProcessedFrames)
    ? Math.max(frames.length, Math.floor(totalProcessedFrames))
    : frames.length;
  const repCount = frames.reduce((maximum, frame) => Math.max(maximum, normalizeRepCount(frame.repCount)), 0);
  const supported = frames.filter(isSupportedFrame);
  const supportedFrames = supported.length;
  const supportedFrameRatio = analyzedFrames > 0 ? supportedFrames / analyzedFrames : 0;
  const averageConfidence = mean(supported.map((frame) => normalizeConfidence(frame.confidence)));

  const reason = getUnassessedReason({
    analyzedFrames,
    repCount,
    supportedFrames,
    supportedFrameRatio
  });

  if (reason) {
    return {
      status: "unassessed",
      repCount,
      analyzedFrames,
      supportedFrames,
      averageConfidence: roundMetric(averageConfidence),
      primaryCue: null,
      signals: [{ label: "Clip assessment", detail: reason, status: "waiting" }],
      supportedFrameRatio: roundMetric(supportedFrameRatio),
      reason
    };
  }

  const observations = collectCueObservations(supported, repCount);
  const requiredRepOccurrences = repCount === 1 ? 1 : Math.max(2, Math.ceil(repCount / 2));
  const recurring = [...observations.values()]
    .filter((observation) => observation.reps.size >= requiredRepOccurrences)
    .sort(compareCueObservations)
    .slice(0, CLIP_SUMMARY_THRESHOLDS.maximumSignals);

  if (recurring.length === 0) {
    const detail = `No recurring high-confidence adjustment was identified across ${formatRepCount(repCount)}. This is not a safety verdict.`;
    return {
      status: "assessed",
      repCount,
      analyzedFrames,
      supportedFrames,
      averageConfidence: roundMetric(averageConfidence),
      primaryCue: { title: "No repeatable adjustment identified", detail },
      signals: [{ label: "Observed swings", detail, status: "good" }],
      supportedFrameRatio: roundMetric(supportedFrameRatio),
      reason: null
    };
  }

  const signals = recurring.map<ClipSummarySignal>((observation) => ({
    label: observation.label,
    detail: observation.detail,
    status: "watch"
  }));
  const primary = recurring[0];

  return {
    status: "assessed",
    repCount,
    analyzedFrames,
    supportedFrames,
    averageConfidence: roundMetric(averageConfidence),
    primaryCue: { title: primary.label, detail: primary.detail },
    signals,
    supportedFrameRatio: roundMetric(supportedFrameRatio),
    reason: null
  };
}

function getUnassessedReason({
  analyzedFrames,
  repCount,
  supportedFrames,
  supportedFrameRatio
}: {
  analyzedFrames: number;
  repCount: number;
  supportedFrames: number;
  supportedFrameRatio: number;
}): string | null {
  if (analyzedFrames === 0) {
    return UNASSESSED_REASONS.noFrames;
  }
  if (analyzedFrames < CLIP_SUMMARY_THRESHOLDS.minimumAnalyzedFrames) {
    return UNASSESSED_REASONS.tooFewFrames;
  }
  if (repCount < CLIP_SUMMARY_THRESHOLDS.minimumCompletedReps) {
    return UNASSESSED_REASONS.tooFewCompleteReps;
  }
  if (supportedFrames < CLIP_SUMMARY_THRESHOLDS.minimumSupportedFrames) {
    return UNASSESSED_REASONS.tooLittleSupport;
  }
  if (supportedFrameRatio < CLIP_SUMMARY_THRESHOLDS.minimumSupportedFrameRatio) {
    return UNASSESSED_REASONS.tooLittleCoverage;
  }
  return null;
}

function isSupportedFrame(frame: ClipAnalysisFrame): boolean {
  return (
    frame.assessmentStatus === "assessed" &&
    Number.isFinite(frame.confidence) &&
    frame.confidence >= CLIP_SUMMARY_THRESHOLDS.minimumFrameConfidence
  );
}

function collectCueObservations(
  frames: readonly ClipAnalysisFrame[],
  completedRepCount: number
): Map<string, CueObservation> {
  const observations = new Map<string, CueObservation>();

  for (const frame of frames) {
    const rep = getObservationRep(frame);
    if (rep < 1 || rep > completedRepCount) {
      continue;
    }

    for (const feedback of frame.feedback) {
      if (feedback.severity === "good" || !feedback.label.trim() || !feedback.detail.trim()) {
        continue;
      }

      const key = feedback.id?.trim() || feedback.label.trim().toLocaleLowerCase();
      const severityRank = feedback.severity === "fix" ? 2 : 1;
      const representativeScore = Number.isFinite(feedback.score) ? feedback.score! : 1;
      const existing = observations.get(key);

      if (!existing) {
        observations.set(key, {
          key,
          label: feedback.label.trim(),
          detail: feedback.detail.trim(),
          severity: feedback.severity,
          severityRank,
          representativeScore,
          confidenceTotal: normalizeConfidence(frame.confidence),
          occurrences: 1,
          reps: new Set([rep])
        });
        continue;
      }

      existing.reps.add(rep);
      existing.occurrences += 1;
      existing.confidenceTotal += normalizeConfidence(frame.confidence);

      if (
        severityRank > existing.severityRank ||
        (severityRank === existing.severityRank && representativeScore < existing.representativeScore)
      ) {
        existing.label = feedback.label.trim();
        existing.detail = feedback.detail.trim();
        existing.severity = feedback.severity;
        existing.severityRank = severityRank;
        existing.representativeScore = representativeScore;
      }
    }
  }

  return observations;
}

function getObservationRep(frame: ClipAnalysisFrame): number {
  const completed = normalizeRepCount(frame.repCount);
  if (frame.phase === "backswing" || frame.phase === "drive") {
    return completed + 1;
  }
  if (frame.phase === "float" || frame.phase === "lockout") {
    return Math.max(1, completed);
  }
  return completed;
}

function compareCueObservations(left: CueObservation, right: CueObservation): number {
  return (
    right.severityRank - left.severityRank ||
    right.reps.size - left.reps.size ||
    right.occurrences - left.occurrences ||
    right.confidenceTotal / right.occurrences - left.confidenceTotal / left.occurrences ||
    left.key.localeCompare(right.key)
  );
}

function normalizeRepCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatRepCount(repCount: number): string {
  return `${repCount} completed ${repCount === 1 ? "rep" : "reps"}`;
}
