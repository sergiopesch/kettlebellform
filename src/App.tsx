import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ChevronsRight,
  CircleAlert,
  CircleCheck,
  Film,
  Gauge,
  Info,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  ScanLine,
  Settings,
  ShieldCheck,
  Square,
  Timer,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { usePoseCoach, type CameraFacingMode } from "./hooks/usePoseCoach";
import { useSpokenFramingCoach } from "./hooks/useSpokenFramingCoach";
import {
  COACH_VOICE_PROFILES,
  getCoachVoiceProfile,
  type VoiceProfileId
} from "./lib/coachVoiceProfiles";
import { getFramingCue } from "./lib/framingCoach";
import type {
  AnalysisFrame,
  AnatomyLayerId,
  AnatomyLayerState,
  CoachSettings,
  FeedbackSignal
} from "./types";

const PoseScene = lazy(() =>
  import("./components/PoseScene").then((module) => ({ default: module.PoseScene }))
);

const VideoClipWorkspace = lazy(() => import("./components/VideoClipWorkspace"));

const defaultSettings: CoachSettings = {
  heightCm: 178,
  bellKg: 16,
  experience: "trained",
  goal: "technique",
  sideView: true
};

const defaultAnatomyLayers: AnatomyLayerState = {
  body: true,
  muscles: false,
  skeleton: true,
  gaussian: false
};

const focusLabels: Record<CoachSettings["goal"], string> = {
  technique: "Technique",
  power: "Power",
  conditioning: "Conditioning"
};

const phaseLabels: Record<AnalysisFrame["phase"], string> = {
  waiting: "Waiting",
  backswing: "Backswing",
  drive: "Drive",
  float: "Float",
  lockout: "Finish"
};

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function App() {
  const [settings, setSettings] = useState<CoachSettings>(defaultSettings);
  const [anatomyLayers, setAnatomyLayers] = useState<AnatomyLayerState>(defaultAnatomyLayers);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [clipOpen, setClipOpen] = useState(false);
  const previousSourceRef = useRef<"camera" | "demo" | null>(null);
  const clipTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreClipFocusRef = useRef(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openClip = useCallback(() => setClipOpen(true), []);
  const closeClip = useCallback(() => {
    restoreClipFocusRef.current = true;
    setClipOpen(false);
  }, []);

  const coach = usePoseCoach(settings, anatomyLayers);
  const sessionActive =
    coach.mode === "requesting" ||
    coach.mode === "live" ||
    coach.mode === "demo" ||
    coach.mode === "paused";
  const requestingCamera = coach.mode === "requesting";
  const paused = coach.mode === "paused";
  const demo = coach.source === "demo";
  const framingCue = useMemo(
    () => getFramingCue(coach.analysis?.landmarks, {
      mirrored: coach.cameraOptics?.mirrored ?? false,
      aspectRatio: coach.cameraOptics?.aspectRatio,
      requireSideView: settings.sideView
    }),
    [
      coach.analysis?.landmarks,
      coach.cameraOptics?.aspectRatio,
      coach.cameraOptics?.mirrored,
      settings.sideView
    ]
  );
  const voiceCoach = useSpokenFramingCoach({
    cue: framingCue,
    sessionActive: coach.source !== null,
    motionActive:
      coach.source === "camera" &&
      coach.analysis !== null &&
      coach.analysis.phase !== "waiting",
    automatic:
      coach.source === "camera" &&
      coach.mode === "live" &&
      !coach.isCalibrating
  });
  const disableVoiceCoach = voiceCoach.disable;

  useEffect(() => {
    if (coach.source !== previousSourceRef.current) {
      if (previousSourceRef.current && !coach.source) {
        disableVoiceCoach();
      }
      previousSourceRef.current = coach.source;
      setElapsedSeconds(coach.source === "demo" ? 102 : 0);
    }
  }, [coach.source, disableVoiceCoach]);

  useEffect(() => {
    if (!sessionActive || paused) {
      return;
    }
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [paused, sessionActive]);

  useEffect(() => {
    if (!clipOpen && restoreClipFocusRef.current) {
      restoreClipFocusRef.current = false;
      clipTriggerRef.current?.focus();
    }
  }, [clipOpen]);

  const modelLabel = useMemo(() => {
    if (coach.modelStatus === "loading") {
      return "Loading model";
    }
    if (coach.modelStatus === "error") {
      return "Model unavailable";
    }
    return coach.modelDelegate ? `Model ready · ${coach.modelDelegate}` : "Model ready";
  }, [coach.modelDelegate, coach.modelStatus]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to coaching workspace
      </a>

      <header className="app-header">
        <a className="brand" href="#main-content" aria-label="KB Form home">
          <ChevronsRight className="brand-mark" aria-hidden="true" />
          <span>KB FORM</span>
        </a>

        <div className="header-status" data-status={coach.modelStatus} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {coach.modelStatus === "error"
              ? modelLabel
              : coach.clipBusy
                ? "Analyzing clip locally"
                : clipOpen
                  ? "Clip workspace · local"
                  : sessionActive
                ? requestingCamera
                ? "Connecting camera"
                : paused
                  ? "Coaching paused"
                  : demo
                    ? "Preview coaching"
                    : "Live coaching"
                : modelLabel}
          </span>
        </div>

        <div className="header-actions">
          {sessionActive ? (
            <>
              {!requestingCamera ? (
                <button className="button button-quiet" type="button" onClick={coach.togglePause} aria-label={paused ? "Resume coaching" : "Pause coaching"}>
                  {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                  <span>{paused ? "Resume" : "Pause"}</span>
                </button>
              ) : null}
              <button
                className="button button-quiet"
                type="button"
                onClick={coach.endSession}
                aria-label={requestingCamera ? "Cancel camera setup" : "End session"}
              >
                <Square aria-hidden="true" />
                <span>{requestingCamera ? "Cancel" : "End session"}</span>
              </button>
            </>
          ) : null}
          <button
            className="button button-icon"
            type="button"
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            disabled={coach.clipBusy}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings aria-hidden="true" />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <main id="main-content">
        {clipOpen ? (
          <ErrorBoundary fallback={<div className="clip-load-fallback"><CircleAlert aria-hidden="true" /><strong>Clip workspace unavailable</strong><span>Reload the page and try again. Camera coaching is still available.</span></div>}>
            <Suspense fallback={<div className="clip-load-fallback" role="status"><Film aria-hidden="true" /><strong>Opening clip workspace…</strong></div>}>
              <VideoClipWorkspace
                modelStatus={coach.modelStatus}
                modelError={coach.modelError}
                analyzeClip={coach.analyzeClip}
                cancelClipAnalysis={coach.cancelClipAnalysis}
                onClose={closeClip}
              />
            </Suspense>
          </ErrorBoundary>
        ) : sessionActive ? (
          <LiveWorkspace
            coach={coach}
            voiceCoach={voiceCoach}
            attachVideo={coach.attachVideo}
            attachOverlay={coach.attachOverlay}
            demo={demo}
            elapsedSeconds={elapsedSeconds}
            movementOpen={movementOpen}
            setMovementOpen={setMovementOpen}
            anatomyLayers={anatomyLayers}
            setAnatomyLayers={setAnatomyLayers}
          />
        ) : (
          <ReadyWorkspace
            coach={coach}
            voiceCoach={voiceCoach}
            settings={settings}
            setSettings={setSettings}
            movementOpen={movementOpen}
            setMovementOpen={setMovementOpen}
            clipTriggerRef={clipTriggerRef}
            onOpenClip={openClip}
          />
        )}
      </main>

      {settingsOpen ? (
        <SettingsDrawer
          settings={settings}
          setSettings={setSettings}
          calibration={coach.calibration}
          resetCalibration={coach.resetCalibration}
          onClose={closeSettings}
        />
      ) : null}
    </div>
  );
}

type CoachController = ReturnType<typeof usePoseCoach>;
type VoiceCoachController = ReturnType<typeof useSpokenFramingCoach>;

function ReadyWorkspace({
  coach,
  voiceCoach,
  settings,
  setSettings,
  movementOpen,
  setMovementOpen,
  clipTriggerRef,
  onOpenClip
}: {
  coach: CoachController;
  voiceCoach: VoiceCoachController;
  settings: CoachSettings;
  setSettings: React.Dispatch<React.SetStateAction<CoachSettings>>;
  movementOpen: boolean;
  setMovementOpen: React.Dispatch<React.SetStateAction<boolean>>;
  clipTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onOpenClip: () => void;
}) {
  const requesting = coach.mode === "requesting";
  const [cameraFacingMode, setCameraFacingMode] = useState<CameraFacingMode>("environment");

  return (
    <div className="ready-layout">
      <section className="camera-setup" aria-labelledby="setup-title">
        <div className="setup-copy">
          <span className="eyebrow">Two-hand hip-hinge swing</span>
          <h1 id="setup-title">Set up your camera</h1>
          <p>Side view · full body · well lit</p>
        </div>

        <div className="framing-stage" aria-label="Camera framing guide">
          <span className="frame-corner frame-corner-tl" aria-hidden="true" />
          <span className="frame-corner frame-corner-tr" aria-hidden="true" />
          <span className="frame-corner frame-corner-bl" aria-hidden="true" />
          <span className="frame-corner frame-corner-br" aria-hidden="true" />
          <span className="frame-label frame-label-top">Head in frame</span>
          <span className="frame-label frame-label-bottom">Feet and floor visible</span>
          <img className="framing-reference" src="/demo-swing.png" alt="" />
          <div className="distance-chip">
            <ArrowRight aria-hidden="true" />
            <span>Fill about 55–80% of the full frame</span>
          </div>
        </div>

        <div className="camera-preferences">
          <fieldset className="camera-view-picker">
            <legend>Camera view</legend>
            <button
              type="button"
              aria-pressed={cameraFacingMode === "environment"}
              onClick={() => setCameraFacingMode("environment")}
            >
              <ScanLine aria-hidden="true" />
              <span>
                <strong>Room view</strong>
                <small>Environment-facing when supported</small>
              </span>
              <em>Recommended</em>
            </button>
            <button
              type="button"
              aria-pressed={cameraFacingMode === "user"}
              onClick={() => setCameraFacingMode("user")}
            >
              <Camera aria-hidden="true" />
              <span>
                <strong>Selfie view</strong>
                <small>Keep the screen facing you</small>
              </span>
            </button>
          </fieldset>

          <VoiceCoachToggle voiceCoach={voiceCoach} compact={false} />
        </div>

        <div className="setup-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={() => coach.startCamera(cameraFacingMode)}
            disabled={coach.modelStatus !== "ready" || requesting}
          >
            <Camera aria-hidden="true" />
            <span>{requesting ? "Requesting camera…" : "Start camera"}</span>
          </button>
          <button className="button button-secondary" type="button" onClick={coach.startDemo}>
            <Play aria-hidden="true" />
            <span>Preview coaching</span>
          </button>
          <button ref={clipTriggerRef} className="button button-secondary" type="button" onClick={onOpenClip}>
            <Film aria-hidden="true" />
            <span>Analyze a clip</span>
          </button>
        </div>

        <div className="privacy-line">
          <LockKeyhole aria-hidden="true" />
          <span>
            Pose video stays in this browser. If voice is on, the browser sends only an
            allowlisted cue ID to our server; OpenAI receives its matching fixed phrase. Never
            microphone audio, camera frames, or landmarks.
          </span>
        </div>

        {coach.modelError || coach.cameraError ? (
          <div className="notice notice-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{coach.cameraError || coach.modelError}</span>
          </div>
        ) : null}
        {voiceCoach.speechStatus ? (
          <p className="inline-status" role="status">{voiceCoach.speechStatus}</p>
        ) : null}
      </section>

      <aside className="prep-rail" aria-labelledby="prep-title">
        <div className="rail-heading">
          <span className="eyebrow">Quick check</span>
          <h2 id="prep-title">Before you swing</h2>
        </div>

        <ol className="prep-list">
          <PrepItem number="01" title="Clear the space" detail="Leave room for the bell in front and behind you." />
          <PrepItem number="02" title="Stand side-on" detail="Keep your head, hands, bell, and feet visible." />
          <PrepItem number="03" title="Choose one style" detail="This version assesses two-hand, shoulder-height hip-hinge swings." />
        </ol>

        <SessionSetup settings={settings} setSettings={setSettings} />

        <div className="notice notice-safety">
          <ShieldCheck aria-hidden="true" />
          <p>
            <strong>Technique awareness, not a safety verdict.</strong>
            Stop for pain, dizziness, unusual breathlessness, or loss of bell control. New lifters benefit from an in-person coach.
          </p>
        </div>

        <MovementToggle open={movementOpen} onClick={() => setMovementOpen((value) => !value)} />
        {movementOpen ? (
          <div className="movement-explainer">
            <Activity aria-hidden="true" />
            <div>
              <strong>Movement detail activates with a live pose.</strong>
              <span>It is an illustrative 3D view, not a diagnosis of joints, muscles, or spinal load.</span>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function LiveWorkspace({
  coach,
  voiceCoach,
  attachVideo,
  attachOverlay,
  demo,
  elapsedSeconds,
  movementOpen,
  setMovementOpen,
  anatomyLayers,
  setAnatomyLayers
}: {
  coach: CoachController;
  voiceCoach: VoiceCoachController;
  attachVideo: CoachController["attachVideo"];
  attachOverlay: CoachController["attachOverlay"];
  demo: boolean;
  elapsedSeconds: number;
  movementOpen: boolean;
  setMovementOpen: React.Dispatch<React.SetStateAction<boolean>>;
  anatomyLayers: AnatomyLayerState;
  setAnatomyLayers: React.Dispatch<React.SetStateAction<AnatomyLayerState>>;
}) {
  const assessed = demo || coach.analysis?.assessmentStatus === "assessed";
  const repCount = demo ? 8 : coach.analysis?.repCount ?? 0;
  const phase = demo ? "Drive" : phaseLabels[coach.analysis?.phase ?? "waiting"];
  const cue = getCue(coach.analysis, demo);
  const quality = getViewQuality(coach.analysis, demo);
  const signals = getSignals(coach.analysis, demo, assessed);
  const recentReps = demo ? [0.78, 0.84, 0.75, 0.9, 0.86] : [];
  const cameraOptions = coach.cameraOptions ?? [];
  const cameraAspectRatio = coach.cameraOptics?.aspectRatio;
  const captureStyle = !demo && cameraAspectRatio
    ? { aspectRatio: String(cameraAspectRatio) }
    : undefined;

  return (
    <div className="live-layout">
      <section className="capture-card" aria-label={demo ? "Interactive coaching preview" : "Live camera analysis"}>
        <div className={`capture-media${demo ? " capture-media-demo" : ""}`} style={captureStyle}>
          {demo ? (
            <img className="demo-image" src="/demo-swing-overlay.png" alt="Side-view demonstration of a two-hand shoulder-height kettlebell swing with a pose-tracking overlay" />
          ) : (
            <video
              ref={attachVideo}
              className={`camera-feed${coach.cameraOptics?.mirrored ? " is-mirrored" : ""}`}
              playsInline
              muted
              aria-label={coach.cameraOptics?.mirrored ? "Mirrored live camera feed" : "Live camera feed"}
            />
          )}
          {!demo ? <canvas ref={attachOverlay} className="pose-overlay" aria-label="Pose tracking overlay" /> : null}

          <div className="capture-topline">
            <div className="capture-stat">
              <span>Rep</span>
              <strong>{repCount}</strong>
            </div>
            <div className="phase-chip" data-active={assessed}>
              <span className="status-dot" aria-hidden="true" />
              {phase}
            </div>
          </div>

          <div className="capture-footer">
            <div>
              <Timer aria-hidden="true" />
              <span>{formatTime(elapsedSeconds)}</span>
            </div>
            <div>
              <LockKeyhole aria-hidden="true" />
              <span>{demo ? "Interactive sample · no camera" : "Pose analysis on-device · not recorded"}</span>
            </div>
          </div>

          {coach.mode === "paused" ? (
            <div className="pause-overlay" role="status">
              <Pause aria-hidden="true" />
              <strong>Coaching paused</strong>
              <span>{demo ? "The interactive sample is frozen until you resume." : "The camera stays on, but frames are not being analyzed."}</span>
            </div>
          ) : null}

          {coach.mode === "requesting" ? (
            <div className="tracking-hint" role="status" aria-live="polite">
              <Camera aria-hidden="true" />
              <span>Allow camera access to begin on-device coaching.</span>
            </div>
          ) : !demo && coach.mode !== "paused" && !coach.isCalibrating ? (
            <div
              className="framing-guidance"
              data-tone={voiceCoach.stableCue.tone}
              data-cue={voiceCoach.stableCue.id}
              role="status"
              aria-live="polite"
            >
              {voiceCoach.stableCue.id === "move-left" ||
              voiceCoach.stableCue.id === "move-right" ||
              voiceCoach.stableCue.id === "step-back" ||
              voiceCoach.stableCue.id === "move-closer" ? (
                <ArrowRight aria-hidden="true" />
              ) : (
                <ScanLine aria-hidden="true" />
              )}
              <span>
                <strong>{voiceCoach.stableCue.label}</strong>
                <small>{voiceCoach.stableCue.detail}</small>
              </span>
            </div>
          ) : null}

          {coach.isCalibrating ? (
            <div className="calibration-overlay" role="status">
              <div>
                <Gauge aria-hidden="true" />
                <span>Stand tall and still</span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Upright reference progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(coach.calibrationProgress * 100)}
              >
                <span style={{ width: `${coach.calibrationProgress * 100}%` }} />
              </div>
            </div>
          ) : null}
        </div>

        {coach.modelError ? (
          <div className="notice notice-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{coach.modelError} End the session and reload before trying again.</span>
          </div>
        ) : null}

        {!demo && coach.mode !== "requesting" ? (
          <div className="capture-tools">
            <div className="capture-control-group">
              <button className="button button-secondary" type="button" onClick={coach.startCalibration} disabled={coach.mode !== "live" || coach.isCalibrating}>
                <Gauge aria-hidden="true" />
                <span>{coach.calibration ? "Refresh upright reference" : "Set upright reference"}</span>
              </button>
              {cameraOptions.length > 1 ? (
                <label className="camera-select">
                  <ScanLine aria-hidden="true" />
                  <span>Camera</span>
                  <select
                    value={coach.activeCameraId ?? ""}
                    onChange={(event) => coach.selectCamera(event.target.value)}
                    disabled={coach.mode !== "live"}
                  >
                    {!coach.activeCameraId ? <option value="">Current camera</option> : null}
                    {cameraOptions.map((camera) => (
                      <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {cameraOptions.length > 0 ? (
                <button
                  className="button button-icon icon-only"
                  type="button"
                  aria-label="Refresh camera list"
                  onClick={coach.refreshCameraOptions}
                  disabled={coach.mode !== "live"}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              ) : null}
              {coach.cameraOptics ? (
                <button
                  className="button button-quiet"
                  type="button"
                  aria-label="Mirror camera preview"
                  aria-pressed={coach.cameraOptics.mirrored}
                  onClick={coach.toggleCameraMirror}
                  disabled={coach.mode !== "live"}
                  title={coach.cameraOptics.mirroringKnown
                    ? "Change how the preview is displayed."
                    : "This camera did not report its direction. Toggle this if left and right feel reversed."}
                >
                  <ScanLine aria-hidden="true" />
                  <span>Mirror preview</span>
                </button>
              ) : null}
              <VoiceCoachToggle voiceCoach={voiceCoach} compact />
              {voiceCoach.enabled ? (
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={voiceCoach.repeat}
                  disabled={!voiceCoach.canRepeat}
                >
                  <Volume2 aria-hidden="true" />
                  <span>Repeat cue</span>
                </button>
              ) : null}
            </div>
            <div className="engine-readout" aria-label="Pose engine performance">
              <Activity aria-hidden="true" />
              <span>
                {coach.inferenceMs ? `${Math.round(coach.inferenceMs)} ms` : "Waiting for pose"}
                {" · Full frame"}
                {coach.cameraOptics?.minimumZoomApplied ? " · minimum zoom" : ""}
              </span>
            </div>
          </div>
        ) : null}

        {coach.calibrationMessage ? <p className="inline-status" role="status">{coach.calibrationMessage}</p> : null}
        {voiceCoach.speechStatus ? <p className="inline-status" role="status">{voiceCoach.speechStatus}</p> : null}
      </section>

      <aside className="coach-rail" aria-label="Coaching feedback">
        <section className="cue-card" aria-live="polite">
          <span className="eyebrow">Current cue</span>
          <h1>{cue.title}</h1>
          <p>{cue.detail}</p>
        </section>

        <section className="quality-card" aria-label="View quality">
          <div>
            <span className="eyebrow">View quality</span>
            <strong>{quality.label}</strong>
          </div>
          <div className="quality-meter" aria-hidden="true">
            <span style={{ width: `${quality.value * 100}%` }} />
          </div>
          <small>{quality.detail}</small>
        </section>

        <section className="signal-section" aria-labelledby="signals-title">
          <div className="section-heading">
            <h2 id="signals-title">This rep</h2>
            <span>{assessed ? "Observable signals" : "Not assessed"}</span>
          </div>
          <div className="signal-list">
            {signals.map((signal) => <SignalRow key={signal.label} {...signal} />)}
          </div>
        </section>

        <section className="recent-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <h2 id="recent-title">Recent reps</h2>
            <span>{repCount ? `${repCount} detected` : "Complete a full cycle"}</span>
          </div>
          <div className="rep-bars" aria-label={demo ? "Sample recent rep consistency visualization" : "Session rep summary"}>
            {demo ? recentReps.map((value, index) => (
              <span key={`${index}-${value}`} style={{ height: `${Math.max(20, value * 100)}%` }} />
            )) : <small>{repCount ? `${repCount} completed ${repCount === 1 ? "rep" : "reps"}` : "No validated reps yet"}</small>}
          </div>
        </section>

        <div className="notice notice-safety compact">
          <Info aria-hidden="true" />
          <p>Pose estimates cannot measure pain, bracing, muscle use, spinal load, or injury risk. Stop if you feel pain or lose control.</p>
        </div>

        <MovementToggle open={movementOpen} onClick={() => setMovementOpen((value) => !value)} />

        {movementOpen ? (
          <section className="movement-panel" aria-label="Illustrative 3D movement detail">
            {demo || !coach.analysis ? (
              <div className="movement-empty">
                <Activity aria-hidden="true" />
                <strong>Live pose required</strong>
                <span>The 3D view opens when a camera pose is confidently tracked.</span>
              </div>
            ) : (
              <ErrorBoundary fallback={<div className="movement-empty"><CircleAlert aria-hidden="true" /><strong>3D view unavailable</strong><span>Your live coaching still works without WebGL.</span></div>}>
                <Suspense fallback={<div className="movement-empty"><Activity aria-hidden="true" /><strong>Loading movement view…</strong></div>}>
                  <div className="scene-wrap">
                    <PoseScene analysis={coach.analysis} layers={anatomyLayers} />
                  </div>
                </Suspense>
              </ErrorBoundary>
            )}
            <LayerControls layers={anatomyLayers} setLayers={setAnatomyLayers} />
            <p className="movement-caption">Illustrative landmark view—not anatomy, diagnosis, or load measurement.</p>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

function SessionSetup({
  settings,
  setSettings
}: {
  settings: CoachSettings;
  setSettings: React.Dispatch<React.SetStateAction<CoachSettings>>;
}) {
  return (
    <section className="session-setup" aria-labelledby="session-setup-title">
      <div className="section-heading">
        <h2 id="session-setup-title">Session setup</h2>
        <span>Adjust anytime</span>
      </div>
      <div className="setup-fields">
        <label>
          <span>Bell</span>
          <div className="number-field">
            <input
              type="number"
              min={4}
              max={64}
              inputMode="numeric"
              value={settings.bellKg}
              onChange={(event) => setSettings((current) => ({ ...current, bellKg: clampNumber(event.target.value, 4, 64) }))}
            />
            <span>kg</span>
          </div>
        </label>
        <label>
          <span>Experience</span>
          <select
            value={settings.experience}
            onChange={(event) => setSettings((current) => ({ ...current, experience: event.target.value as CoachSettings["experience"] }))}
          >
            <option value="new">New</option>
            <option value="trained">Trained</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
      </div>
      <div className="focus-field">
        <span>Focus</span>
        <div className="segmented-control" role="group" aria-label="Coaching focus">
          {(Object.keys(focusLabels) as Array<CoachSettings["goal"]>).map((goal) => (
            <button
              type="button"
              key={goal}
              aria-pressed={settings.goal === goal}
              className={settings.goal === goal ? "selected" : ""}
              onClick={() => setSettings((current) => ({ ...current, goal }))}
            >
              {focusLabels[goal]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function SettingsDrawer({
  settings,
  setSettings,
  calibration,
  resetCalibration,
  onClose
}: {
  settings: CoachSettings;
  setSettings: React.Dispatch<React.SetStateAction<CoachSettings>>;
  calibration: CoachController["calibration"];
  resetCalibration: () => void;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={drawerRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">Preferences</span>
            <h2 id="settings-title">Coaching setup</h2>
          </div>
          <button ref={closeButtonRef} className="button button-icon icon-only" type="button" aria-label="Close settings" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>

        <SessionSetup settings={settings} setSettings={setSettings} />

        <section className="settings-section">
          <span className="eyebrow">Supported movement</span>
          <strong>Two-hand · shoulder-height · hip-hinge swing</strong>
          <p>The first validated mode stays deliberately narrow. Other swing styles should not be interpreted as faults.</p>
        </section>

        <section className="settings-section">
          <span className="eyebrow">Upright reference</span>
          <strong>{calibration ? `${calibration.sampleCount} accepted samples` : "Using conservative defaults"}</strong>
          <p>{calibration ? "Your reference is used only in this browser session." : "Set a standing reference once the live camera is running."}</p>
          {calibration ? (
            <button className="button button-secondary" type="button" onClick={resetCalibration}>
              <RotateCcw aria-hidden="true" />
              <span>Clear reference</span>
            </button>
          ) : null}
        </section>

        <section className="settings-section">
          <span className="eyebrow">Voice framing</span>
          <strong>Two AI command profiles · no microphone</strong>
          <p>
            After you opt in, the browser sends only an allowlisted cue ID to our server and
            OpenAI Realtime receives its matching positioning phrase. Camera frames, landmarks,
            and microphone audio are never sent. If Realtime fails, KB FORM uses a local English
            device voice when available, then falls back to visual cues. Availability and
            OS/browser privacy behaviour vary.
          </p>
        </section>

        <div className="notice notice-safety compact">
          <ShieldCheck aria-hidden="true" />
          <p>KB FORM is a general-wellness technique aid. It does not diagnose, treat, prevent injury, or replace a qualified professional.</p>
        </div>
      </aside>
    </div>
  );
}

function VoiceCoachToggle({
  voiceCoach,
  compact
}: {
  voiceCoach: VoiceCoachController;
  compact: boolean;
}) {
  const activeProfile = getCoachVoiceProfile(voiceCoach.selectedProfile);
  const connecting = voiceCoach.transport === "connecting";
  const detail = connecting
    ? "Connecting securely to OpenAI Realtime…"
    : voiceCoach.availability === "loading"
      ? "Finding a compatible voice…"
    : voiceCoach.availability === "unavailable"
      ? "Voice unavailable · visual cues stay active"
      : voiceCoach.enabled && voiceCoach.transport === "realtime"
        ? `On · ${activeProfile.label} · OpenAI Realtime`
        : voiceCoach.enabled && voiceCoach.transport === "device"
          ? "On · local device fallback · voice/privacy may vary"
          : "Off · no microphone access";

  const chooseProfile = (profile: VoiceProfileId) => {
    voiceCoach.selectProfile(profile);
  };

  return (
    <div className={`voice-coach-control${compact ? " is-compact" : ""}`}>
      {compact ? (
        <label className="voice-profile-select">
          <span>Coach voice</span>
          <select
            aria-label="Coach voice"
            value={voiceCoach.selectedProfile}
            disabled={connecting}
            onChange={(event) => chooseProfile(event.target.value as VoiceProfileId)}
          >
            {COACH_VOICE_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </label>
      ) : (
        <fieldset className="voice-profile-picker">
          <legend>Choose an AI coach voice</legend>
          {COACH_VOICE_PROFILES.map((profile) => (
            <button
              key={profile.id}
              type="button"
              aria-label={profile.accessibleLabel}
              aria-pressed={voiceCoach.selectedProfile === profile.id}
              disabled={connecting}
              onClick={() => chooseProfile(profile.id)}
            >
              <span>
                <strong>{profile.label}</strong>
                <small>{profile.description}</small>
              </span>
            </button>
          ))}
        </fieldset>
      )}

      <button
        className={`voice-coach-toggle${compact ? " is-compact" : ""}`}
        type="button"
        aria-pressed={voiceCoach.enabled}
        aria-busy={connecting}
        disabled={voiceCoach.availability !== "ready" && !voiceCoach.enabled}
        onClick={voiceCoach.toggle}
      >
        {voiceCoach.enabled ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
        <span>
          <strong>{connecting ? "Connecting voice coach" : "Voice framing coach"}</strong>
          <small>{detail}</small>
        </span>
      </button>

      {!compact ? (
        <p className="voice-ai-disclosure">
          AI-generated speech, not a human coach recording. Only fixed framing text is sent when on.
        </p>
      ) : null}
    </div>
  );
}

function PrepItem({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <li>
      <span>{number}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <Check aria-hidden="true" />
    </li>
  );
}

function SignalRow({ label, status, detail }: { label: string; status: "good" | "watch" | "waiting"; detail: string }) {
  return (
    <div className="signal-row" data-status={status}>
      {status === "good" ? <CircleCheck aria-hidden="true" /> : status === "watch" ? <CircleAlert aria-hidden="true" /> : <span className="signal-placeholder" aria-hidden="true" />}
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function MovementToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button className="movement-toggle" type="button" onClick={onClick} aria-expanded={open}>
      <span>
        <Activity aria-hidden="true" />
        Movement detail
      </span>
      <ChevronDown aria-hidden="true" />
    </button>
  );
}

function LayerControls({
  layers,
  setLayers
}: {
  layers: AnatomyLayerState;
  setLayers: React.Dispatch<React.SetStateAction<AnatomyLayerState>>;
}) {
  const controls: Array<{ id: AnatomyLayerId; label: string }> = [
    { id: "body", label: "Body" },
    { id: "muscles", label: "Regions" },
    { id: "skeleton", label: "Skeleton" },
    { id: "gaussian", label: "Trail" }
  ];

  return (
    <div className="layer-controls" role="group" aria-label="3D movement layers">
      {controls.map((control) => (
        <button
          type="button"
          key={control.id}
          aria-pressed={layers[control.id]}
          className={layers[control.id] ? "selected" : ""}
          onClick={() => setLayers((current) => ({ ...current, [control.id]: !current[control.id] }))}
        >
          {control.label}
        </button>
      ))}
    </div>
  );
}

function getCue(analysis: AnalysisFrame | null, demo: boolean): { title: string; detail: string } {
  if (demo) {
    return { title: "Drive through the hips", detail: "Let the bell float. Keep your arms relaxed." };
  }
  if (!analysis || analysis.confidence < 0.62) {
    return { title: "Find a clear side view", detail: "Keep your head, hands, bell, and feet visible before coaching begins." };
  }
  if (analysis.assessmentStatus === "unassessed") {
    return { title: "Ready when you are", detail: "Complete a visible backswing, drive, and float before coaching begins." };
  }
  if (analysis.phase === "waiting") {
    return { title: "Ready when you are", detail: "Begin with a controlled hike, then complete a full swing cycle." };
  }
  const feedback = analysis.feedback.find((item) => item.severity !== "good") ?? analysis.feedback[0];
  return feedback
    ? { title: feedback.label, detail: feedback.detail }
    : { title: "Rep observed", detail: "No high-confidence adjustment is available for this frame." };
}

function getViewQuality(analysis: AnalysisFrame | null, demo: boolean): { label: string; value: number; detail: string } {
  if (demo) {
    return { label: "Good", value: 0.88, detail: "Full body · side view · steady light" };
  }
  const confidence = analysis?.confidence ?? 0;
  if (confidence >= 0.78) {
    return { label: "Good", value: confidence, detail: "Full body and key landmarks are visible" };
  }
  if (confidence >= 0.62) {
    return { label: "Fair", value: confidence, detail: "Keep the bell and both feet in frame" };
  }
  return { label: "Adjust view", value: Math.max(0.12, confidence), detail: "Move side-on and show your full body" };
}

function signalFromFeedback(label: string, feedback: FeedbackSignal | undefined, assessed: boolean) {
  if (!assessed || !feedback) {
    return {
      label,
      status: "waiting" as const,
      detail: assessed ? "No supported observation" : "Awaiting a clear full rep"
    };
  }
  const status = feedback.severity === "good" ? "good" as const : "watch" as const;
  return { label, status, detail: feedback.severity === "good" ? "On track" : "Watch next rep" };
}

function getSignals(analysis: AnalysisFrame | null, demo: boolean, assessed: boolean) {
  if (demo) {
    return [
      { label: "Hip hinge", status: "good" as const, detail: "On track" },
      { label: "Knee bend", status: "watch" as const, detail: "Watch next rep" },
      { label: "Tall finish", status: "good" as const, detail: "On track" }
    ];
  }

  return [
    signalFromFeedback("Hip hinge", analysis?.feedback.find((item) => item.joint === "hips"), assessed),
    signalFromFeedback("Knee bend", analysis?.feedback.find((item) => item.joint === "knees"), assessed),
    signalFromFeedback("Tall finish", analysis?.feedback.find((item) => item.joint === "spine"), assessed)
  ];
}

function clampNumber(raw: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}
