import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  Activity,
  BicepsFlexed,
  Bone,
  Camera,
  CheckCircle2,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  UserRound,
  Video,
  Waves
} from "lucide-react";
import { PoseScene } from "./components/PoseScene";
import { drawPoseOverlay } from "./lib/drawing";
import { createPoseLandmarker } from "./lib/posePipeline";
import { createCalibrationProfile, SwingAnalyzer } from "./lib/swingAnalyzer";
import type { AnalysisFrame, AnatomyLayerId, AnatomyLayerState, CalibrationProfile, CoachSettings, PoseFrame } from "./types";

const defaultSettings: CoachSettings = {
  heightCm: 178,
  bellKg: 16,
  experience: "trained",
  goal: "technique",
  sideView: true
};

const defaultAnatomyLayers: AnatomyLayerState = {
  body: true,
  muscles: true,
  skeleton: true,
  gaussian: true
};

const anatomyLayerControls: Array<{
  id: AnatomyLayerId;
  label: string;
  icon: typeof UserRound;
}> = [
  { id: "body", label: "Body", icon: UserRound },
  { id: "muscles", label: "Muscle", icon: BicepsFlexed },
  { id: "skeleton", label: "Bone", icon: Bone },
  { id: "gaussian", label: "Field", icon: Activity }
];

type ModelStatus = "loading" | "ready" | "error";
type CameraStatus = "idle" | "ready" | "error";

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyzerRef = useRef(new SwingAnalyzer());
  const calibrationSamplesRef = useRef<PoseFrame[]>([]);
  const calibrationStartedAtRef = useRef(0);
  const lastUiUpdateRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);

  const [modelStatus, setModelStatus] = useState<ModelStatus>("loading");
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const [modelError, setModelError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisFrame | null>(null);
  const [settings, setSettings] = useState<CoachSettings>(defaultSettings);
  const [calibration, setCalibration] = useState<CalibrationProfile | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [anatomyLayers, setAnatomyLayers] = useState<AnatomyLayerState>(defaultAnatomyLayers);

  useEffect(() => {
    let cancelled = false;

    createPoseLandmarker()
      .then((landmarker) => {
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setModelStatus("ready");
      })
      .catch((error: unknown) => {
        setModelStatus("error");
        setModelError(error instanceof Error ? error.message : "Pose model failed to load.");
      });

    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("error");
      setCameraError("This browser does not expose camera capture.");
      return;
    }

    try {
      setCameraError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 },
          facingMode: "user"
        },
        audio: false
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        return;
      }
      video.srcObject = stream;
      await video.play();
      setCameraStatus("ready");
      setIsRunning(true);
    } catch (error) {
      setCameraStatus("error");
      setCameraError(error instanceof Error ? error.message : "Camera permission failed.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    setIsRunning(false);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyzerRef.current.reset();
    setAnalysis(null);
    setCameraStatus("idle");
  }, []);

  const startCalibration = useCallback(() => {
    calibrationSamplesRef.current = [];
    calibrationStartedAtRef.current = performance.now();
    setCalibrationProgress(0);
    setIsCalibrating(true);
  }, []);

  const resetSession = useCallback(() => {
    analyzerRef.current.reset();
    calibrationSamplesRef.current = [];
    setAnalysis(null);
    setCalibration(null);
    setIsCalibrating(false);
    setCalibrationProgress(0);
  }, []);

  useEffect(() => {
    if (!isRunning || modelStatus !== "ready") {
      return;
    }

    let frameId = 0;
    let disposed = false;

    const runFrame = () => {
      if (disposed) {
        return;
      }

      const video = videoRef.current;
      const canvas = overlayRef.current;
      const landmarker = landmarkerRef.current;
      if (video && canvas && landmarker && video.readyState >= 2) {
        if (video.currentTime !== lastVideoTimeRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          const timestamp = performance.now();
          const result = landmarker.detectForVideo(video, timestamp);
          const landmarks = result.landmarks[0];
          const worldLandmarks = result.worldLandmarks[0];

          if (landmarks && worldLandmarks) {
            const poseFrame: PoseFrame = { timestamp, landmarks, worldLandmarks };

            if (isCalibrating) {
              calibrationSamplesRef.current.push(poseFrame);
              const elapsed = timestamp - calibrationStartedAtRef.current;
              const progress = Math.min(1, Math.max(calibrationSamplesRef.current.length / 72, elapsed / 2600));
              setCalibrationProgress(progress);

              if (progress >= 1) {
                const profile = createCalibrationProfile(calibrationSamplesRef.current);
                if (profile) {
                  setCalibration(profile);
                  analyzerRef.current.reset();
                }
                setIsCalibrating(false);
              }
            }

            const nextAnalysis = analyzerRef.current.update(poseFrame, settings, calibration);
            drawPoseOverlay(canvas, video, nextAnalysis, true, anatomyLayers);

            if (timestamp - lastUiUpdateRef.current > 90) {
              setAnalysis(nextAnalysis);
              lastUiUpdateRef.current = timestamp;
            }
          } else {
            drawPoseOverlay(canvas, video, null, true, anatomyLayers);
          }
        }
      }

      frameId = requestAnimationFrame(runFrame);
    };

    runFrame();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
    };
  }, [anatomyLayers, calibration, isCalibrating, isRunning, modelStatus, settings]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const primaryFeedback = analysis?.feedback[0];
  const modelReady = modelStatus === "ready";
  const canRun = modelReady && cameraStatus === "ready";
  const statusText = useMemo(() => {
    if (modelStatus === "loading") {
      return "Loading pose model";
    }
    if (modelStatus === "error") {
      return "Model unavailable";
    }
    if (cameraStatus === "idle") {
      return "Camera idle";
    }
    if (cameraStatus === "error") {
      return "Camera unavailable";
    }
    if (isCalibrating) {
      return "Calibrating";
    }
    return isRunning ? "Live coaching" : "Paused";
  }, [cameraStatus, isCalibrating, isRunning, modelStatus]);

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Session controls">
        <div className="brand-mark">
          <Waves aria-hidden="true" />
          <span>KB Form</span>
        </div>

        <div className="status-pill" data-status={modelStatus === "error" || cameraStatus === "error" ? "bad" : "good"}>
          <span className="status-dot" />
          {statusText}
        </div>

        <div className="topbar-actions">
          {cameraStatus === "ready" ? (
            <button className="icon-button" type="button" onClick={() => setIsRunning((value) => !value)} disabled={!modelReady}>
              {isRunning ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              <span>{isRunning ? "Pause" : "Resume"}</span>
            </button>
          ) : (
            <button className="icon-button primary" type="button" onClick={startCamera} disabled={!modelReady}>
              <Camera aria-hidden="true" />
              <span>Start</span>
            </button>
          )}
          <button className="icon-button" type="button" onClick={startCalibration} disabled={!canRun || isCalibrating}>
            <Gauge aria-hidden="true" />
            <span>Calibrate</span>
          </button>
          <button className="icon-button" type="button" onClick={resetSession}>
            <RotateCcw aria-hidden="true" />
            <span>Reset</span>
          </button>
        </div>
      </section>

      <section className="workspace">
        <div className="capture-panel">
          <video ref={videoRef} className="camera-feed" playsInline muted />
          <canvas ref={overlayRef} className="pose-overlay" />
          <div className="capture-readout">
            <div>
              <span>Score</span>
              <strong>{analysis?.score ?? "--"}</strong>
            </div>
            <div>
              <span>Reps</span>
              <strong>{analysis?.repCount ?? 0}</strong>
            </div>
            <div>
              <span>Phase</span>
              <strong>{analysis?.phase ?? "waiting"}</strong>
            </div>
          </div>
          {!isRunning && cameraStatus !== "ready" ? (
            <div className="camera-empty">
              <Video aria-hidden="true" />
              <span>{modelReady ? "Start camera" : "Loading model"}</span>
            </div>
          ) : null}
          {isCalibrating ? (
            <div className="calibration-banner">
              <CheckCircle2 aria-hidden="true" />
              <div className="calibration-track">
                <span style={{ width: `${Math.round(calibrationProgress * 100)}%` }} />
              </div>
            </div>
          ) : null}
        </div>

        <aside className="coach-panel">
          <div className="score-card">
            <div className="score-ring" style={{ "--score": `${analysis?.score ?? 0}%` } as CSSProperties}>
              <span>{analysis?.score ?? "--"}</span>
            </div>
            <div>
              <span className="eyebrow">Coach read</span>
              <h1>{primaryFeedback?.label ?? "Awaiting movement"}</h1>
              <p>{primaryFeedback?.detail ?? "Side-view swings give the coach the cleanest hinge and depth signal."}</p>
            </div>
          </div>

          <div className="feedback-stack">
            {(analysis?.feedback ?? []).map((item) => (
              <div className="feedback-row" data-severity={item.severity} key={item.id}>
                <span />
                <div>
                  <strong>{item.label}</strong>
                  <small>{Math.round(item.score * 100)}%</small>
                </div>
              </div>
            ))}
          </div>

          <div className="metric-grid">
            <MetricTile label="Hinge" value={analysis?.metrics.hingeRatio ?? 0} suffix="x" max={2.2} />
            <MetricTile label="Depth" value={analysis?.metrics.depthTravel ?? 0} suffix="" max={1} />
            <MetricTile label="Stack" value={analysis?.metrics.spineStack ?? 0} suffix="" max={1} />
            <MetricTile label="Camera" value={analysis?.metrics.cameraQuality ?? 0} suffix="" max={1} />
          </div>
        </aside>

        <div className="scene-panel">
          <PoseScene analysis={analysis} layers={anatomyLayers} />
          <div className="anatomy-controls" aria-label="3D anatomy layers">
            {anatomyLayerControls.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={anatomyLayers[item.id] ? "selected" : ""}
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setAnatomyLayers((current) => ({
                      ...current,
                      [item.id]: !current[item.id]
                    }))
                  }
                  title={`${item.label} layer`}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <div className="scene-readout">
            <Activity aria-hidden="true" />
            <span>3D world pose</span>
            <strong>{analysis ? `${Math.round((analysis.confidence ?? 0) * 100)}%` : "--"}</strong>
          </div>
        </div>

        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          calibration={calibration}
          modelStatus={modelStatus}
          cameraError={cameraError}
          modelError={modelError}
          stopCamera={stopCamera}
        />
      </section>
    </main>
  );
}

function MetricTile({
  label,
  value,
  suffix,
  max
}: {
  label: string;
  value: number;
  suffix: string;
  max: number;
}) {
  const normalized = Math.max(0, Math.min(1, value / max));
  const display = suffix === "x" ? value.toFixed(2) : `${Math.round(value * 100)}`;
  return (
    <div className="metric-tile">
      <div>
        <span>{label}</span>
        <strong>
          {display}
          {suffix}
        </strong>
      </div>
      <div className="meter">
        <span style={{ width: `${normalized * 100}%` }} />
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  setSettings,
  calibration,
  modelStatus,
  cameraError,
  modelError,
  stopCamera
}: {
  settings: CoachSettings;
  setSettings: Dispatch<SetStateAction<CoachSettings>>;
  calibration: CalibrationProfile | null;
  modelStatus: ModelStatus;
  cameraError: string;
  modelError: string;
  stopCamera: () => void;
}) {
  return (
    <aside className="settings-panel">
      <div className="panel-title">
        <SlidersHorizontal aria-hidden="true" />
        <span>Profile</span>
      </div>

      <label className="field">
        <span>Height</span>
        <input
          min={130}
          max={220}
          type="number"
          value={settings.heightCm}
          onChange={(event) => setSettings((current) => ({ ...current, heightCm: Number(event.target.value) }))}
        />
      </label>

      <label className="field">
        <span>Bell</span>
        <input
          min={4}
          max={64}
          type="number"
          value={settings.bellKg}
          onChange={(event) => setSettings((current) => ({ ...current, bellKg: Number(event.target.value) }))}
        />
      </label>

      <label className="field">
        <span>Level</span>
        <select
          value={settings.experience}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              experience: event.target.value as CoachSettings["experience"]
            }))
          }
        >
          <option value="new">New</option>
          <option value="trained">Trained</option>
          <option value="advanced">Advanced</option>
        </select>
      </label>

      <div className="segmented" role="group" aria-label="Coaching goal">
        {(["technique", "power", "rehab"] as const).map((goal) => (
          <button
            className={settings.goal === goal ? "selected" : ""}
            key={goal}
            type="button"
            onClick={() => setSettings((current) => ({ ...current, goal }))}
          >
            {goal}
          </button>
        ))}
      </div>

      <label className="check-field">
        <input
          checked={settings.sideView}
          type="checkbox"
          onChange={(event) => setSettings((current) => ({ ...current, sideView: event.target.checked }))}
        />
        <span>Side view</span>
      </label>

      <div className="calibration-card">
        <span>Calibration</span>
        <strong>{calibration ? `${calibration.sampleCount} frames` : "Default"}</strong>
        <small>{calibration ? `Jitter ${calibration.jitter.toFixed(1)} deg` : "Use a tall standing sample"}</small>
      </div>

      {modelStatus === "error" || cameraError ? (
        <div className="error-box">
          <span>{modelError || cameraError}</span>
        </div>
      ) : null}

      <button className="text-button" type="button" onClick={stopCamera}>
        Stop camera
      </button>
    </aside>
  );
}
