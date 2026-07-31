import { useCallback, useEffect, useRef, useState } from "react";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { drawPoseOverlay } from "../lib/drawing";
import { createCalibrationProfile, SwingAnalyzer } from "../lib/swingAnalyzer";
import type {
  AnalysisFrame,
  AnatomyLayerState,
  CalibrationProfile,
  CoachSettings,
  PoseFrame
} from "../types";

export type ModelStatus = "loading" | "ready" | "error";
export type SessionMode = "ready" | "requesting" | "live" | "paused" | "demo";
export type SessionSource = "camera" | "demo" | null;

type WorkerMessage =
  | { type: "ready"; delegate: "GPU" | "CPU"; version: string }
  | {
      type: "result";
      timestamp: number;
      inferenceMs: number;
      landmarks: NormalizedLandmark[] | null;
      worldLandmarks: Landmark[] | null;
    }
  | { type: "error"; fatal: boolean; message: string };

const MIN_CALIBRATION_SAMPLES = 48;
const MIN_CALIBRATION_MS = 2_000;
const LOST_POSE_TIMEOUT_MS = 750;

function isFinitePose(landmarks: NormalizedLandmark[] | null, worldLandmarks: Landmark[] | null): boolean {
  if (!landmarks || !worldLandmarks || landmarks.length < 33 || worldLandmarks.length < 33) {
    return false;
  }

  const coordinatesAreFinite = [...landmarks, ...worldLandmarks].every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  );
  const visibilityIsValid = landmarks.every(
    (point) =>
      Number.isFinite(point.visibility) &&
      (point.visibility ?? -1) >= 0 &&
      (point.visibility ?? 2) <= 1
  );
  return coordinatesAreFinite && visibilityIsValid;
}

export function usePoseCoach(settings: CoachSettings, anatomyLayers: AnatomyLayerState) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequestIdRef = useRef(0);
  const cameraRequestInFlightRef = useRef(false);
  const modeRef = useRef<SessionMode>("ready");
  const inFlightRef = useRef(false);
  const analyzerRef = useRef(new SwingAnalyzer());
  const settingsRef = useRef(settings);
  const anatomyLayersRef = useRef(anatomyLayers);
  const calibrationRef = useRef<CalibrationProfile | null>(null);
  const calibrationSamplesRef = useRef<PoseFrame[]>([]);
  const calibrationStartedAtRef = useRef(0);
  const lastPoseAtRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  const [modelStatus, setModelStatus] = useState<ModelStatus>("loading");
  const [modelError, setModelError] = useState("");
  const [modelDelegate, setModelDelegate] = useState<"GPU" | "CPU" | null>(null);
  const [mode, setMode] = useState<SessionMode>("ready");
  const [source, setSource] = useState<SessionSource>(null);
  const [cameraError, setCameraError] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisFrame | null>(null);
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [calibration, setCalibration] = useState<CalibrationProfile | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [calibrationMessage, setCalibrationMessage] = useState("");

  const updateMode = useCallback((nextMode: SessionMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    anatomyLayersRef.current = anatomyLayers;
  }, [anatomyLayers]);

  useEffect(() => {
    calibrationRef.current = calibration;
  }, [calibration]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/poseWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;

      if (message.type === "ready") {
        setModelDelegate(message.delegate);
        setModelStatus("ready");
        setModelError("");
        return;
      }

      if (message.type === "error") {
        inFlightRef.current = false;
        if (message.fatal) {
          analyzerRef.current.reset();
          calibrationStartedAtRef.current = 0;
          calibrationSamplesRef.current = [];
          setAnalysis(null);
          setIsCalibrating(false);
          setCalibrationProgress(0);
          setModelStatus("error");
          setModelError(message.message);
        }
        return;
      }

      inFlightRef.current = false;
      if (modeRef.current !== "live") {
        return;
      }
      const canvas = overlayRef.current;
      const video = videoRef.current;

      if (!isFinitePose(message.landmarks, message.worldLandmarks)) {
        if (performance.now() - lastPoseAtRef.current > LOST_POSE_TIMEOUT_MS) {
          setAnalysis(null);
          if (canvas && video) {
            drawPoseOverlay(canvas, video, null, true, anatomyLayersRef.current);
          }
        }
        return;
      }

      const poseFrame: PoseFrame = {
        timestamp: message.timestamp,
        landmarks: message.landmarks!,
        worldLandmarks: message.worldLandmarks!
      };
      lastPoseAtRef.current = performance.now();

      if (calibrationStartedAtRef.current > 0) {
        calibrationSamplesRef.current.push(poseFrame);
        const elapsed = message.timestamp - calibrationStartedAtRef.current;
        const sampleProgress = calibrationSamplesRef.current.length / MIN_CALIBRATION_SAMPLES;
        const timeProgress = elapsed / MIN_CALIBRATION_MS;
        const progress = Math.min(1, sampleProgress, timeProgress);
        setCalibrationProgress(progress);

        if (sampleProgress >= 1 && timeProgress >= 1) {
          const profile = createCalibrationProfile(calibrationSamplesRef.current);
          calibrationStartedAtRef.current = 0;
          setIsCalibrating(false);
          if (profile) {
            calibrationRef.current = profile;
            setCalibration(profile);
            analyzerRef.current.reset();
            setCalibrationMessage("Upright reference saved.");
          } else {
            setCalibrationMessage("Reference not saved. Stand tall, side-on, and keep your full body in view.");
          }
        }
      }

      try {
        const nextAnalysis = analyzerRef.current.update(
          poseFrame,
          settingsRef.current,
          calibrationRef.current
        );
        if (canvas && video) {
          drawPoseOverlay(canvas, video, nextAnalysis, true, anatomyLayersRef.current);
        }

        if (message.timestamp - lastUiUpdateRef.current >= 100) {
          setAnalysis(nextAnalysis);
          setInferenceMs(message.inferenceMs);
          lastUiUpdateRef.current = message.timestamp;
        }
      } catch {
        if (performance.now() - lastPoseAtRef.current > LOST_POSE_TIMEOUT_MS) {
          setAnalysis(null);
        }
      }
    };

    worker.onerror = () => {
      analyzerRef.current.reset();
      calibrationStartedAtRef.current = 0;
      calibrationSamplesRef.current = [];
      setAnalysis(null);
      setIsCalibrating(false);
      setCalibrationProgress(0);
      setModelStatus("error");
      setModelError("The background pose engine stopped unexpectedly.");
      inFlightRef.current = false;
    };

    worker.postMessage({ type: "initialize" });

    return () => {
      worker.postMessage({ type: "close" });
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const cancelCalibration = useCallback(() => {
    calibrationStartedAtRef.current = 0;
    calibrationSamplesRef.current = [];
    setIsCalibrating(false);
    setCalibrationProgress(0);
  }, []);

  const releaseCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const endSession = useCallback(() => {
    cameraRequestIdRef.current += 1;
    cameraRequestInFlightRef.current = false;
    releaseCamera();
    cancelCalibration();
    analyzerRef.current.reset();
    inFlightRef.current = false;
    setAnalysis(null);
    setInferenceMs(null);
    setCalibrationMessage("");
    lastUiUpdateRef.current = 0;
    setSource(null);
    updateMode("ready");
    const canvas = overlayRef.current;
    if (canvas) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [cancelCalibration, releaseCamera, updateMode]);

  const startCamera = useCallback(async () => {
    if (cameraRequestInFlightRef.current) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera capture is unavailable in this browser.");
      return;
    }

    const requestId = cameraRequestIdRef.current + 1;
    cameraRequestIdRef.current = requestId;
    cameraRequestInFlightRef.current = true;
    setSource("camera");
    updateMode("requesting");
    setCameraError("");
    setCalibrationMessage("");
    releaseCamera();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: "user"
        },
        audio: false
      });
      if (cameraRequestIdRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => endSession();
      }
      updateMode("live");
    } catch (error) {
      if (cameraRequestIdRef.current !== requestId) {
        return;
      }
      releaseCamera();
      setSource(null);
      updateMode("ready");
      setCameraError(error instanceof Error ? error.message : "Camera permission was not granted.");
    } finally {
      if (cameraRequestIdRef.current === requestId) {
        cameraRequestInFlightRef.current = false;
      }
    }
  }, [endSession, releaseCamera, updateMode]);

  const startDemo = useCallback(() => {
    cameraRequestIdRef.current += 1;
    cameraRequestInFlightRef.current = false;
    releaseCamera();
    cancelCalibration();
    setCameraError("");
    setCalibrationMessage("");
    setAnalysis(null);
    setSource("demo");
    updateMode("demo");
  }, [cancelCalibration, releaseCamera, updateMode]);

  const togglePause = useCallback(() => {
    setMode((current) => {
      let nextMode = current;
      if (current === "live" || current === "demo") {
        cancelCalibration();
        nextMode = "paused";
      }
      if (current === "paused") {
        nextMode = streamRef.current ? "live" : "demo";
      }
      modeRef.current = nextMode;
      return nextMode;
    });
  }, [cancelCalibration]);

  const startCalibration = useCallback(() => {
    if (mode !== "live") {
      return;
    }
    calibrationSamplesRef.current = [];
    calibrationStartedAtRef.current = performance.now();
    setCalibrationProgress(0);
    setCalibrationMessage("");
    setIsCalibrating(true);
  }, [mode]);

  const resetCalibration = useCallback(() => {
    cancelCalibration();
    calibrationRef.current = null;
    setCalibration(null);
    setCalibrationMessage("");
    analyzerRef.current.reset();
    setAnalysis(null);
  }, [cancelCalibration]);

  useEffect(() => {
    if (mode !== "live" || modelStatus !== "ready") {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    const stream = streamRef.current;
    if (!stream) {
      setCameraError("The camera stream ended before coaching could begin.");
      setSource(null);
      updateMode("ready");
      return;
    }

    video.srcObject = stream;

    let active = true;
    let videoFrameHandle = 0;
    let animationFrameHandle = 0;

    const submitFrame = async (timestamp: number) => {
      if (!active || inFlightRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }

      inFlightRef.current = true;
      try {
        const frame = await createImageBitmap(video);
        if (!active || !workerRef.current) {
          frame.close();
          inFlightRef.current = false;
          return;
        }
        workerRef.current.postMessage({ type: "frame", frame, timestamp }, [frame]);
      } catch {
        inFlightRef.current = false;
      }
    };

    const scheduleVideoFrame = () => {
      if (!active) {
        return;
      }
      if ("requestVideoFrameCallback" in video) {
        videoFrameHandle = video.requestVideoFrameCallback((now) => {
          void submitFrame(now);
          scheduleVideoFrame();
        });
      } else {
        animationFrameHandle = requestAnimationFrame((now) => {
          void submitFrame(now);
          scheduleVideoFrame();
        });
      }
    };

    void video.play().then(scheduleVideoFrame).catch((error: unknown) => {
      if (!active) {
        return;
      }
      cameraRequestIdRef.current += 1;
      releaseCamera();
      setSource(null);
      updateMode("ready");
      setCameraError(error instanceof Error ? error.message : "The camera feed could not start.");
    });
    return () => {
      active = false;
      if (videoFrameHandle && "cancelVideoFrameCallback" in video) {
        video.cancelVideoFrameCallback(videoFrameHandle);
      }
      cancelAnimationFrame(animationFrameHandle);
    };
  }, [mode, modelStatus, releaseCamera, updateMode]);

  useEffect(
    () => () => {
      cameraRequestIdRef.current += 1;
      cameraRequestInFlightRef.current = false;
      releaseCamera();
    },
    [releaseCamera]
  );

  const setVideoElement = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
  }, []);

  const setOverlayElement = useCallback((element: HTMLCanvasElement | null) => {
    overlayRef.current = element;
  }, []);

  return {
    attachVideo: setVideoElement,
    attachOverlay: setOverlayElement,
    modelStatus,
    modelError,
    modelDelegate,
    mode,
    source,
    cameraError,
    analysis,
    inferenceMs,
    calibration,
    isCalibrating,
    calibrationProgress,
    calibrationMessage,
    startCamera,
    startDemo,
    togglePause,
    endSession,
    startCalibration,
    resetCalibration
  };
}
