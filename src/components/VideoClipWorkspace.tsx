import {
  CircleAlert,
  CircleCheck,
  Crop,
  Film,
  Info,
  LockKeyhole,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  ScanLine,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipAnalysisOptions,
  ClipAnalysisProgress,
  ClipAnalysisRunResult,
  ModelStatus
} from "../hooks/usePoseCoach";
import { buildClipAnalysisSummary } from "../lib/clipAnalysis";
import { drawPoseOverlay } from "../lib/drawing";
import {
  VIDEO_CLIP_LIMITS,
  clampCropRect,
  clampTrimRange,
  getCropPixels,
  getInferenceDimensions,
  mapAnalysisToSource,
  validateVideoFile,
  validateVideoMetadata,
  type NormalizedCropRect
} from "../lib/videoClip";
import type { AnalysisFrame, AnatomyLayerState } from "../types";
import { KettlebellSwingLoader } from "./KettlebellSwingLoader";

type VideoClipWorkspaceProps = {
  modelStatus: ModelStatus;
  modelError: string;
  analyzeClip: (options: ClipAnalysisOptions) => Promise<ClipAnalysisRunResult>;
  cancelClipAnalysis: () => void;
  onClose: () => void;
};

type ClipSource = {
  url: string;
  name: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
};

type WorkspaceStage = "editing" | "analyzing" | "result";
type DragState = {
  pointerId: number;
  mode: "move" | "resize";
  startClientX: number;
  startClientY: number;
  initialCrop: NormalizedCropRect;
};

const INITIAL_CROP: NormalizedCropRect = { x: 0.14, y: 0.04, width: 0.72, height: 0.92 };
const EMPTY_PROGRESS: ClipAnalysisProgress = {
  stage: "preparing",
  progress: 0,
  processedFrames: 0,
  expectedFrames: 0
};
const RESULT_LAYERS: AnatomyLayerState = {
  body: false,
  muscles: false,
  skeleton: true,
  gaussian: true
};

function formatClipTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export default function VideoClipWorkspace({
  modelStatus,
  modelError,
  analyzeClip,
  cancelClipAnalysis,
  onClose
}: VideoClipWorkspaceProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadButtonRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [clip, setClip] = useState<ClipSource | null>(null);
  const [stage, setStage] = useState<WorkspaceStage>("editing");
  const [trim, setTrim] = useState({ start: 0, end: 10 });
  const [crop, setCrop] = useState<NormalizedCropRect>(INITIAL_CROP);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [sourcePlaying, setSourcePlaying] = useState(false);
  const [progress, setProgress] = useState<ClipAnalysisProgress>(EMPTY_PROGRESS);
  const [result, setResult] = useState<ReturnType<typeof buildClipAnalysisSummary> | null>(null);
  const [resultFrame, setResultFrame] = useState<AnalysisFrame | null>(null);

  const disposeVideo = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      cancelClipAnalysis();
      disposeVideo();
    },
    [cancelClipAnalysis, disposeVideo]
  );

  useEffect(() => {
    if (!clip) {
      uploadButtonRef.current?.focus();
    }
  }, [clip]);

  useEffect(() => {
    if (stage === "result" && result) {
      resultHeadingRef.current?.focus();
    }
  }, [result, stage]);

  const resetResult = useCallback(() => {
    setStage("editing");
    setResult(null);
    setResultFrame(null);
    setProgress(EMPTY_PROGRESS);
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const rejectCurrentClip = useCallback((message: string) => {
    cancelClipAnalysis();
    disposeVideo();
    setClip(null);
    setPreviewing(false);
    setSourcePlaying(false);
    setError(message);
    resetResult();
  }, [cancelClipAnalysis, disposeVideo, resetResult]);

  const removeClip = useCallback(() => {
    cancelClipAnalysis();
    disposeVideo();
    setClip(null);
    setError("");
    setPreviewing(false);
    setSourcePlaying(false);
    setTrim({ start: 0, end: 10 });
    setCrop(INITIAL_CROP);
    resetResult();
  }, [cancelClipAnalysis, disposeVideo, resetResult]);

  const chooseFile = useCallback((file: File | undefined) => {
    if (!file) {
      return;
    }
    const validationError = validateVideoFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    disposeVideo();
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setClip({ url, name: file.name.slice(0, 140), size: file.size, duration: null, width: null, height: null });
    setError("");
    setTrim({ start: 0, end: 10 });
    setCrop(INITIAL_CROP);
    setPreviewing(false);
    setSourcePlaying(false);
    resetResult();
  }, [disposeVideo, resetResult]);

  const onMetadataLoaded = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const metadataError = validateVideoMetadata({
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight
    });
    if (metadataError) {
      rejectCurrentClip(metadataError);
      return;
    }
    const nextTrim = clampTrimRange(0, Math.min(VIDEO_CLIP_LIMITS.maxSelectionSeconds, video.duration), video.duration);
    setTrim(nextTrim);
    setClip((current) => current ? {
      ...current,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight
    } : current);
  }, [rejectCurrentClip]);

  const updateStart = useCallback((value: number) => {
    if (!clip?.duration) {
      return;
    }
    setTrim((current) => clampTrimRange(value, current.end, clip.duration, "start"));
    resetResult();
  }, [clip, resetResult]);

  const updateEnd = useCallback((value: number) => {
    if (!clip?.duration) {
      return;
    }
    setTrim((current) => clampTrimRange(current.start, value, clip.duration, "end"));
    resetResult();
  }, [clip, resetResult]);

  const adjustCropScale = useCallback((factor: number) => {
    setCrop((current) => {
      const nextWidth = current.width * factor;
      const nextHeight = current.height * factor;
      return clampCropRect({
        x: current.x + (current.width - nextWidth) / 2,
        y: current.y + (current.height - nextHeight) / 2,
        width: nextWidth,
        height: nextHeight
      });
    });
    resetResult();
  }, [resetResult]);

  const beginCropDrag = useCallback((event: React.PointerEvent<HTMLElement>, mode: DragState["mode"]) => {
    if (stage !== "editing") {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialCrop: crop
    };
  }, [crop, stage]);

  const moveCropDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const stageElement = stageRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !stageElement) {
      return;
    }
    const bounds = stageElement.getBoundingClientRect();
    const deltaX = (event.clientX - drag.startClientX) / Math.max(1, bounds.width);
    const deltaY = (event.clientY - drag.startClientY) / Math.max(1, bounds.height);
    const next = drag.mode === "move"
      ? { ...drag.initialCrop, x: drag.initialCrop.x + deltaX, y: drag.initialCrop.y + deltaY }
      : {
          ...drag.initialCrop,
          width: drag.initialCrop.width + deltaX,
          height: drag.initialCrop.height + deltaY
        };
    setCrop(clampCropRect(next));
  }, []);

  const endCropDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    resetResult();
  }, [resetResult]);

  const moveCropWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 0.03 : 0.01;
    setCrop((current) => clampCropRect({
      ...current,
      x: current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      y: current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)
    }));
    resetResult();
  }, [resetResult]);

  const resizeCropWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.03 : 0.01;
    setCrop((current) => clampCropRect({
      ...current,
      width: current.width + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      height: current.height + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)
    }));
    resetResult();
  }, [resetResult]);

  const previewSelection = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !clip?.duration) {
      return;
    }
    setError("");
    video.currentTime = trim.start;
    video.playbackRate = 1;
    video.muted = true;
    setPreviewing(true);
    setSourcePlaying(false);
    try {
      await video.play();
    } catch {
      setPreviewing(false);
      setError("This browser could not preview the selected window.");
    }
  }, [clip, trim.start]);

  const toggleSourcePlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !clip?.duration) {
      return;
    }
    if (!video.paused) {
      video.pause();
      return;
    }
    if (video.currentTime >= clip.duration - 0.05) {
      video.currentTime = 0;
    }
    video.playbackRate = 1;
    video.muted = true;
    setPreviewing(false);
    setSourcePlaying(true);
    setError("");
    try {
      await video.play();
    } catch {
      setSourcePlaying(false);
      setError("This browser could not play the source video.");
    }
  }, [clip]);

  const analyzeSelection = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !clip?.duration || !clip.width || !clip.height) {
      return;
    }
    const sourceCrop = getCropPixels(crop, clip.width, clip.height);
    const output = getInferenceDimensions(sourceCrop.width, sourceCrop.height);
    setError("");
    setPreviewing(false);
    setSourcePlaying(false);
    setResult(null);
    setResultFrame(null);
    setProgress(EMPTY_PROGRESS);
    setStage("analyzing");
    try {
      const run = await analyzeClip({
        video,
        startTime: trim.start,
        endTime: trim.end,
        crop,
        output,
        onProgress: setProgress
      });
      const summary = buildClipAnalysisSummary(
        run.samples.map((sample) => sample.analysis),
        run.processedFrames
      );
      const bestSample = [...run.samples].sort((left, right) => {
        const leftValue = (left.analysis.assessmentStatus === "assessed" ? 10 : 0) + left.analysis.repCount * 2 + left.analysis.confidence;
        const rightValue = (right.analysis.assessmentStatus === "assessed" ? 10 : 0) + right.analysis.repCount * 2 + right.analysis.confidence;
        return rightValue - leftValue;
      })[0];
      const mappedFrame = bestSample ? mapAnalysisToSource(bestSample.analysis, crop) : null;
      setResult(summary);
      setResultFrame(mappedFrame);
      setStage("result");
      video.currentTime = bestSample ? bestSample.sourceTimestamp / 1_000 : trim.start;
    } catch (analysisError) {
      setStage("editing");
      if (!isAbortError(analysisError)) {
        setError(analysisError instanceof Error ? analysisError.message : "This clip could not be analyzed.");
      }
    }
  }, [analyzeClip, clip, crop, trim.end, trim.start]);

  useEffect(() => {
    if (stage !== "result") {
      return;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      return;
    }
    const draw = () => drawPoseOverlay(canvas, video, resultFrame, false, RESULT_LAYERS);
    const animationFrame = requestAnimationFrame(draw);
    video.addEventListener("seeked", draw, { once: true });
    return () => {
      cancelAnimationFrame(animationFrame);
      video.removeEventListener("seeked", draw);
    };
  }, [resultFrame, stage]);

  const trimDuration = trim.end - trim.start;
  const selectionStyle = useMemo(() => {
    const duration = clip?.duration ?? 1;
    return {
      left: `${(trim.start / duration) * 100}%`,
      width: `${(trimDuration / duration) * 100}%`
    };
  }, [clip?.duration, trim.start, trimDuration]);

  if (!clip) {
    return (
      <div className="clip-empty-layout">
        <section className="clip-drop-card" aria-labelledby="clip-upload-title">
          <button className="clip-close button button-icon icon-only" type="button" onClick={onClose} aria-label="Close clip analysis">
            <X aria-hidden="true" />
          </button>
          <span className="clip-upload-icon" aria-hidden="true"><Upload /></span>
          <span className="eyebrow">On-device video review</span>
          <h1 id="clip-upload-title">Show us three clear swings</h1>
          <p>Choose a short video, then select the clearest 4–10 seconds and frame just the movement you want analyzed.</p>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
            onChange={(event) => {
              chooseFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button ref={uploadButtonRef} className="button button-primary" type="button" onClick={() => inputRef.current?.click()}>
            <Film aria-hidden="true" />
            <span>Choose a video</span>
          </button>
          <div className="clip-format-line">
            <span>MP4 · WebM · MOV</span>
            <span>Up to {VIDEO_CLIP_LIMITS.maxSourceSeconds}s · {Math.round(VIDEO_CLIP_LIMITS.maxBytes / (1024 * 1024))} MB</span>
          </div>
          <div className="privacy-line clip-privacy-line">
            <LockKeyhole aria-hidden="true" />
            <span>Your video never leaves this device. KB FORM does not upload, store, or transcode it.</span>
          </div>
          {error ? <div className="notice notice-error" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span></div> : null}
        </section>
        <aside className="clip-guide-rail" aria-labelledby="clip-guide-title">
          <span className="eyebrow">For a useful review</span>
          <h2 id="clip-guide-title">Capture a clean side view</h2>
          <ol className="prep-list">
            <ClipGuideItem number="01" title="Show your whole body" detail="Keep your head, hands, kettlebell, feet, and floor visible." />
            <ClipGuideItem number="02" title="Stay side-on" detail="Use steady light and avoid people crossing behind you." />
            <ClipGuideItem number="03" title="Include three full cycles" detail="Each needs a visible backswing, hip drive, float, and return before pointers can appear." />
          </ol>
          <div className="notice notice-safety compact">
            <Info aria-hidden="true" />
            <p>Clip pointers are a general-wellness technique aid, not a diagnosis or safety clearance.</p>
          </div>
        </aside>
      </div>
    );
  }

  const metadataReady = clip.duration !== null && clip.width !== null && clip.height !== null;

  return (
    <div className="clip-workspace-layout">
      <section className={`clip-editor-card${stage === "analyzing" ? " is-analyzing" : ""}`} aria-labelledby="clip-editor-title">
        <div className="clip-editor-heading">
          <div>
            <span className="eyebrow">{stage === "result" ? "Clip review" : stage === "analyzing" ? "On-device analysis" : "Choose the clearest swings"}</span>
            <h1 id="clip-editor-title">{stage === "result" ? "Pointers from this clip" : stage === "analyzing" ? "Reading your swing" : "Select 4–10 seconds"}</h1>
          </div>
          <button className="button button-icon icon-only" type="button" onClick={onClose} aria-label="Close clip analysis"><X aria-hidden="true" /></button>
        </div>

        <div
          ref={stageRef}
          className={`clip-video-stage${metadataReady ? " has-metadata" : ""}`}
          style={metadataReady ? { aspectRatio: `${clip.width} / ${clip.height}` } : undefined}
        >
          <video
            ref={videoRef}
            className="clip-video"
            src={clip.url}
            controls={stage === "editing"}
            preload="metadata"
            playsInline
            muted
            aria-label="Selected source video"
            onLoadedMetadata={onMetadataLoaded}
            onError={() => rejectCurrentClip("This browser could not decode the selected video. Try an MP4 or WebM file.")}
            onTimeUpdate={(event) => {
              if (previewing && event.currentTarget.currentTime >= trim.end) {
                event.currentTarget.pause();
                event.currentTarget.currentTime = trim.start;
                setPreviewing(false);
              }
            }}
            onPause={() => {
              setPreviewing(false);
              setSourcePlaying(false);
            }}
          />
          {metadataReady && stage === "editing" ? (
            <>
              <div className="clip-crop-shade" aria-hidden="true" />
              <div
                className="clip-crop-selection"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.width * 100}%`,
                  height: `${crop.height * 100}%`
                }}
                role="group"
                aria-label="Analysis frame. Use arrow keys to move it; hold Shift for larger steps."
                tabIndex={0}
                onKeyDown={moveCropWithKeyboard}
                onPointerDown={(event) => beginCropDrag(event, "move")}
                onPointerMove={moveCropDrag}
                onPointerUp={endCropDrag}
                onPointerCancel={endCropDrag}
              >
                <span className="clip-crop-label"><ScanLine aria-hidden="true" /> Analysis frame</span>
                <button
                  className="clip-resize-handle"
                  type="button"
                  aria-label="Resize analysis frame. Arrow Left and Up shrink; Arrow Right and Down expand. Hold Shift for larger steps."
                  aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
                  onKeyDown={resizeCropWithKeyboard}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    beginCropDrag(event, "resize");
                  }}
                  onPointerMove={moveCropDrag}
                  onPointerUp={endCropDrag}
                  onPointerCancel={endCropDrag}
                />
              </div>
            </>
          ) : null}
          {stage === "result" ? <canvas ref={canvasRef} className="clip-pose-overlay" aria-label="Pose evidence overlay" /> : null}
          {!metadataReady ? <div className="clip-reading" role="status"><Film aria-hidden="true" /><span>Reading clip metadata…</span></div> : null}
        </div>

        {stage === "analyzing" ? (
          <div className="clip-analysis-overlay">
            <KettlebellSwingLoader
              stage={progress.stage}
              progress={progress.progress}
              processedFrames={progress.processedFrames}
              totalFrames={progress.expectedFrames}
              onCancel={cancelClipAnalysis}
            />
          </div>
        ) : null}

        {stage === "editing" && metadataReady ? (
          <div className="clip-timeline-panel">
            <div className="clip-timeline-heading">
              <span>Analysis window · 4–10 seconds</span>
              <strong>{trimDuration.toFixed(1)}s selected</strong>
            </div>
            <div className="clip-timeline-track" aria-hidden="true">
              <span className="clip-timeline-selection" style={selectionStyle} />
            </div>
            <div className="clip-range-fields">
              <label>
                <span>Start <strong>{formatClipTime(trim.start)}</strong></span>
                <input type="range" min={0} max={clip.duration!} step={0.1} value={trim.start} onChange={(event) => updateStart(Number(event.target.value))} />
              </label>
              <label>
                <span>End <strong>{formatClipTime(trim.end)}</strong></span>
                <input type="range" min={0} max={clip.duration!} step={0.1} value={trim.end} onChange={(event) => updateEnd(Number(event.target.value))} />
              </label>
            </div>
            <div className="clip-editor-actions">
              <button className="button button-secondary" type="button" onClick={toggleSourcePlayback}>
                {sourcePlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}<span>{sourcePlaying ? "Pause source" : "Play full source"}</span>
              </button>
              <button className="button button-secondary" type="button" onClick={previewSelection}>
                <Play aria-hidden="true" /><span>{previewing ? "Previewing…" : "Preview selection"}</span>
              </button>
              <button className="button button-secondary" type="button" onClick={() => { setCrop(INITIAL_CROP); resetResult(); }}>
                <RotateCcw aria-hidden="true" /><span>Reset frame</span>
              </button>
              <button className="button button-primary" type="button" disabled={modelStatus !== "ready"} onClick={analyzeSelection}>
                <ScanLine aria-hidden="true" /><span>Analyze selected {trimDuration.toFixed(1)}s</span>
              </button>
            </div>
          </div>
        ) : null}

        {error || modelError ? <div className="notice notice-error clip-error" role="alert"><CircleAlert aria-hidden="true" /><span>{error || modelError}</span></div> : null}
      </section>

      <aside className="clip-editor-rail" aria-label={stage === "result" ? "Clip pointers" : stage === "analyzing" ? "Clip analysis status" : "Clip selection controls"}>
        {stage === "analyzing" ? (
          <>
            <span className="eyebrow">Selected evidence</span>
            <h2 className="clip-analysis-window">{formatClipTime(trim.start)}–{formatClipTime(trim.end)}</h2>
            <dl className="clip-facts">
              <div><dt>Window</dt><dd>{trimDuration.toFixed(1)} seconds</dd></div>
              <div><dt>Frame</dt><dd>{Math.round(crop.width * 100)}% × {Math.round(crop.height * 100)}%</dd></div>
              <div><dt>Processing</dt><dd>One frame at a time</dd></div>
            </dl>
            <div className="notice clip-local-notice">
              <LockKeyhole aria-hidden="true" />
              <p><strong>Local by design</strong>No frames, landmarks, filenames, or pointers are sent to a server.</p>
            </div>
          </>
        ) : stage === "result" && result ? (
          <ClipResultPanel result={result} headingRef={resultHeadingRef} onTryAgain={resetResult} />
        ) : (
          <>
            <div className="rail-heading">
              <span className="eyebrow">Analysis setup</span>
              <h2>Frame the full movement</h2>
            </div>
            <p className="clip-rail-copy">Select 4–10 seconds containing at least three full swings. Keep your head, hands, bell, feet, and the floor inside the lime frame; the full source remains visible and untouched.</p>
            <div className="clip-frame-controls" role="group" aria-label="Analysis frame size">
              <button className="button button-secondary" type="button" onClick={() => adjustCropScale(0.88)}><Crop aria-hidden="true" /><span>Frame tighter</span></button>
              <button className="button button-secondary" type="button" onClick={() => adjustCropScale(1.14)}><Maximize2 aria-hidden="true" /><span>Frame wider</span></button>
            </div>
            <dl className="clip-facts">
              <div><dt>Source</dt><dd title={clip.name}>{clip.name}</dd></div>
              <div><dt>File</dt><dd>{formatBytes(clip.size)}</dd></div>
              {metadataReady ? <div><dt>Video</dt><dd>{clip.width} × {clip.height} · {formatClipTime(clip.duration!)}</dd></div> : null}
              <div><dt>Selection</dt><dd>{trimDuration.toFixed(1)} seconds</dd></div>
            </dl>
            <div className="notice clip-local-notice">
              <LockKeyhole aria-hidden="true" />
              <p><strong>Your clip stays here</strong>Analysis happens in this browser. Nothing is uploaded, stored, or added to your camera roll.</p>
            </div>
            <button className="button button-quiet clip-remove" type="button" onClick={removeClip}><Trash2 aria-hidden="true" /><span>Choose another video</span></button>
          </>
        )}
      </aside>
    </div>
  );
}

function ClipGuideItem({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <li>
      <span>{number}</span>
      <div><strong>{title}</strong><p>{detail}</p></div>
      <CircleCheck aria-hidden="true" />
    </li>
  );
}

function ClipResultPanel({
  result,
  headingRef,
  onTryAgain
}: {
  result: ReturnType<typeof buildClipAnalysisSummary>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onTryAgain: () => void;
}) {
  const assessed = result.status === "assessed";
  return (
    <>
      <section className="clip-result-cue" aria-live="polite">
        <span className="eyebrow">Current cue</span>
        <h2 ref={headingRef} tabIndex={-1}>{result.primaryCue?.title ?? "Unable to assess reliably"}</h2>
        <p>{result.primaryCue?.detail ?? result.reason}</p>
      </section>
      <dl className="clip-result-summary" aria-label="Clip analysis summary">
        <div><dt>Reps observed</dt><dd>{result.repCount}</dd></div>
        <div><dt>View quality</dt><dd>{assessed ? `${Math.round(result.averageConfidence * 100)}%` : "Insufficient"}</dd></div>
        <div><dt>Frames checked</dt><dd>{result.analyzedFrames}</dd></div>
      </dl>
      <section className="signal-section" aria-labelledby="clip-signals-title">
        <div className="section-heading"><h2 id="clip-signals-title">Visible signals</h2><span>{assessed ? "From this clip" : "Not assessed"}</span></div>
        <div className="signal-list">
          {result.signals.map((signal) => (
            <div className="signal-row" data-status={signal.status} key={signal.label}>
              {signal.status === "good" ? <CircleCheck aria-hidden="true" /> : signal.status === "watch" ? <CircleAlert aria-hidden="true" /> : <span className="signal-placeholder" aria-hidden="true" />}
              <div><strong>{signal.label}</strong><span>{signal.detail}</span></div>
            </div>
          ))}
        </div>
      </section>
      <section className="clip-cannot-assess">
        <span className="eyebrow">What we could not assess</span>
            <p>Pain, bracing, breathing, grip security, muscle activation, spinal load, injury risk, and kettlebell identity are not verified from this clip. Keep other people outside the analysis frame.</p>
      </section>
      <button className="button button-primary clip-retry" type="button" onClick={onTryAgain}><RotateCcw aria-hidden="true" /><span>Adjust selection</span></button>
    </>
  );
}
