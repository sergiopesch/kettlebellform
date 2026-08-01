import { useId } from "react";

export type KettlebellSwingStageId = "preparing" | "finding" | "checking" | "building";

const KETTLEBELL_SWING_STAGES: ReadonlyArray<{
  id: KettlebellSwingStageId;
  label: string;
}> = [
  { id: "preparing", label: "Preparing clip" },
  { id: "finding", label: "Finding your swing" },
  { id: "checking", label: "Checking visible signals" },
  { id: "building", label: "Building pointers" }
] as const;

type KettlebellSwingLoaderProps = {
  stage: KettlebellSwingStageId;
  /** A finite analysis progress ratio from 0 to 1. */
  progress: number;
  processedFrames?: number;
  totalFrames?: number;
  onCancel: () => void;
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function KettlebellSwingLoader({
  stage,
  progress,
  processedFrames,
  totalFrames,
  onCancel
}: KettlebellSwingLoaderProps) {
  const titleId = useId();
  const progressDescriptionId = useId();
  const stageIndex = Math.max(
    0,
    KETTLEBELL_SWING_STAGES.findIndex((candidate) => candidate.id === stage)
  );
  const activeStage = KETTLEBELL_SWING_STAGES[stageIndex];
  const progressPercent = Math.round(clamp(progress, 0, 1) * 100);

  const hasFrameProgress =
    Number.isFinite(processedFrames) &&
    Number.isFinite(totalFrames) &&
    (totalFrames ?? 0) > 0;
  const safeTotalFrames = hasFrameProgress ? Math.max(1, Math.floor(totalFrames!)) : 0;
  const safeProcessedFrames = hasFrameProgress
    ? Math.floor(clamp(processedFrames!, 0, safeTotalFrames))
    : Number.isFinite(processedFrames)
      ? Math.max(0, Math.floor(processedFrames!))
      : 0;
  const progressText = hasFrameProgress
    ? `Analyzing frame ${safeProcessedFrames} of ${safeTotalFrames}`
    : Number.isFinite(processedFrames)
      ? `${safeProcessedFrames} frames checked · ${progressPercent}% complete`
      : `${progressPercent}% complete`;

  return (
    <section className="kettlebell-swing-loader" aria-labelledby={titleId} aria-busy="true">
      <div className="kettlebell-swing-loader__visual" aria-hidden="true">
        <div className="kettlebell-swing-loader__motion">
          <svg
            className="kettlebell-swing-loader__mark"
            viewBox="0 0 160 144"
            fill="none"
            focusable="false"
          >
            <path
              className="kettlebell-swing-loader__trajectory"
              d="M25 108C36 58 77 24 130 29"
              pathLength="1"
            />
            <path
              className="kettlebell-swing-loader__trajectory-tip"
              d="m122 20 12 9-10 11"
            />
            <path
              className="kettlebell-swing-loader__handle"
              d="M64 56V48c0-11 7-18 16-18s16 7 16 18v8"
            />
            <path
              className="kettlebell-swing-loader__bell"
              d="M60 53h40l9 18c9 18-3 39-23 39H74c-20 0-32-21-23-39l9-18Z"
            />
            <path
              className="kettlebell-swing-loader__shine"
              d="M69 69c-5 7-6 14-2 21"
            />
          </svg>
        </div>
      </div>

      <div className="kettlebell-swing-loader__content">
        <h2 id={titleId}>Reading your swing</h2>
        <p className="kettlebell-swing-loader__privacy">Your clip stays on this device</p>

        <p className="kettlebell-swing-loader__stage" role="status" aria-live="polite" aria-atomic="true">
          {activeStage.label}
        </p>

        <progress
          className="kettlebell-swing-loader__progress"
          max={100}
          value={progressPercent}
          aria-label="Swing analysis progress"
          aria-valuetext={`${activeStage.label}. ${progressText}.`}
          aria-describedby={progressDescriptionId}
        >
          {progressPercent}%
        </progress>
        <p id={progressDescriptionId} className="kettlebell-swing-loader__progress-text">
          {progressText}
        </p>

        <ol className="kettlebell-swing-loader__stages" aria-label="Analysis stages">
          {KETTLEBELL_SWING_STAGES.map((item, index) => {
            const state = index < stageIndex ? "complete" : index === stageIndex ? "current" : "upcoming";
            return (
              <li
                key={item.id}
                className="kettlebell-swing-loader__stage-item"
                data-state={state}
                aria-current={state === "current" ? "step" : undefined}
              >
                <span className="kettlebell-swing-loader__stage-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{item.label}</span>
              </li>
            );
          })}
        </ol>

        <button className="button button-secondary" type="button" onClick={onCancel}>
          Cancel analysis
        </button>
      </div>
    </section>
  );
}
