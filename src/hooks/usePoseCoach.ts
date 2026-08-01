import { useCallback, useEffect, useRef, useState } from "react";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { drawPoseOverlay } from "../lib/drawing";
import { createCalibrationProfile, SwingAnalyzer } from "../lib/swingAnalyzer";
import {
  VIDEO_CLIP_LIMITS,
  getCropPixels,
  getInferenceDimensions,
  getVideoMediaErrorMessage
} from "../lib/videoClip";
import type {
  AnalysisFrame,
  AnatomyLayerState,
  CalibrationProfile,
  CoachSettings,
  PoseFrame
} from "../types";
import type {
  PoseWorkerFrameRequest,
  PoseWorkerResponse,
  PoseWorkerResultMessage
} from "../workers/poseProtocol";

export type ModelStatus = "loading" | "ready" | "error";
export type SessionMode = "ready" | "requesting" | "live" | "paused" | "demo";
export type SessionSource = "camera" | "demo" | null;
export type CameraFacingMode = "environment" | "user";

export type CameraOption = {
  deviceId: string;
  label: string;
};

export type CameraOptics = {
  mirrored: boolean;
  mirroringKnown: boolean;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  minimumZoomApplied: boolean;
};

export type ClipAnalysisStage = "preparing" | "finding" | "checking" | "building";

export type ClipAnalysisProgress = {
  stage: ClipAnalysisStage;
  progress: number;
  processedFrames: number;
  expectedFrames: number;
};

export type ClipAnalysisSample = {
  sourceTimestamp: number;
  analysis: AnalysisFrame;
};

export type ClipAnalysisRunResult = {
  samples: ClipAnalysisSample[];
  processedFrames: number;
  supportedFrames: number;
  expectedFrames: number;
};

export type ClipAnalysisOptions = {
  video: HTMLVideoElement;
  startTime: number;
  endTime: number;
  crop: { x: number; y: number; width: number; height: number };
  output: { width: number; height: number };
  onProgress: (progress: ClipAnalysisProgress) => void;
};

type ClipFrameWaiter = {
  jobId: number;
  frameId: number;
  resolve: (message: PoseWorkerResultMessage) => void;
  reject: (error: Error) => void;
};

type ActiveClipRun = {
  jobId: number;
  cancel: (recoverTransport?: boolean) => void;
};

type InFlightFrame = Pick<PoseWorkerFrameRequest, "channel" | "jobId" | "frameId"> & {
  worker: Worker;
  transferred: boolean;
};

const MIN_CALIBRATION_SAMPLES = 48;
const MIN_CALIBRATION_MS = 2_000;
const LOST_POSE_TIMEOUT_MS = 750;
const CLIP_SAMPLE_INTERVAL_MS = 1_000 / 15;
const CLIP_TOTAL_TIMEOUT_MS = 30_000;
const CLIP_DECODE_TIMEOUT_MS = 6_000;
const CLIP_EXTRACTION_TIMEOUT_MS = 10_000;
const CLIP_INFERENCE_TIMEOUT_MS = 15_000;
const CLIP_END_TOLERANCE_SECONDS = 0.35;

type ZoomCapabilities = MediaTrackCapabilities & {
  zoom?: { min: number; max: number; step?: number };
};

type ZoomSettings = MediaTrackSettings & {
  zoom?: number;
};

function cameraConstraints(
  facingMode: CameraFacingMode,
  deviceId?: string
): MediaStreamConstraints {
  const video = {
    width: { ideal: 960 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 4 / 3 },
    frameRate: { ideal: 30, max: 30 },
    resizeMode: { ideal: "none" },
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: facingMode } })
  } as MediaTrackConstraints & { resizeMode: { ideal: "none" } };
  return {
    video,
    audio: false
  };
}

function canFallbackFromDeviceError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "OverconstrainedError")
  );
}

function getCameraErrorMessage(error: unknown): string {
  if (!(error instanceof DOMException)) {
    return "The camera could not start. Check browser camera access and try again.";
  }
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Camera access was blocked. Allow camera access for this site, then try again.";
  }
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
    return "That camera is no longer available. Choose another camera and try again.";
  }
  if (error.name === "NotReadableError" || error.name === "AbortError") {
    return "The camera is busy or could not be read. Close other camera apps, then try again.";
  }
  return "The camera could not start. Check browser camera access and try again.";
}

async function applyMinimumZoom(track: MediaStreamTrack): Promise<boolean> {
  try {
    if (!track.getCapabilities || !track.getSettings || !track.applyConstraints) {
      return false;
    }
    const capabilities = track.getCapabilities() as ZoomCapabilities;
    const settings = track.getSettings() as ZoomSettings;
    const minimum = capabilities.zoom?.min;
    const current = settings.zoom;
    if (!Number.isFinite(minimum) || !Number.isFinite(current) || current! <= minimum! + 0.001) {
      return false;
    }
    const existing = track.getConstraints?.() ?? {};
    await track.applyConstraints({
      ...existing,
      advanced: [
        ...(existing.advanced ?? []),
        { zoom: minimum } as MediaTrackConstraintSet
      ]
    });
    const applied = (track.getSettings() as ZoomSettings).zoom;
    return Number.isFinite(applied) && applied! <= minimum! + 0.001;
  } catch {
    return false;
  }
}

function getCameraOptics(
  track: MediaStreamTrack,
  preferredFacingMode: CameraFacingMode,
  minimumZoomApplied: boolean
): CameraOptics {
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings?.() ?? {};
  } catch {
    // Camera settings are optional diagnostics; keep the granted stream usable.
  }
  const width = Number.isFinite(settings.width) ? settings.width! : null;
  const height = Number.isFinite(settings.height) ? settings.height! : null;
  const measuredAspect = width && height ? width / height : null;
  const aspectRatio = Number.isFinite(settings.aspectRatio)
    ? settings.aspectRatio!
    : measuredAspect;
  return {
    mirrored: settings.facingMode
      ? settings.facingMode === "user"
      : preferredFacingMode === "user",
    mirroringKnown: settings.facingMode === "user" || settings.facingMode === "environment",
    width,
    height,
    aspectRatio,
    minimumZoomApplied
  };
}

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
  const inFlightRef = useRef<InFlightFrame | null>(null);
  const modelReadyRef = useRef(false);
  const restartWorkerRef = useRef<(expectedWorker?: Worker) => void>(() => undefined);
  const engineTimestampRef = useRef(0);
  const liveJobIdRef = useRef(0);
  const liveFrameIdRef = useRef(0);
  const liveSourceTimestampRef = useRef(Number.NEGATIVE_INFINITY);
  const clipJobIdRef = useRef(0);
  const clipFrameWaiterRef = useRef<ClipFrameWaiter | null>(null);
  const activeClipRunRef = useRef<ActiveClipRun | null>(null);
  const analyzerRef = useRef(new SwingAnalyzer());
  const settingsRef = useRef(settings);
  const anatomyLayersRef = useRef(anatomyLayers);
  const calibrationRef = useRef<CalibrationProfile | null>(null);
  const calibrationSamplesRef = useRef<PoseFrame[]>([]);
  const calibrationStartedAtRef = useRef(0);
  const lastPoseAtRef = useRef(0);
  const lastUiUpdateRef = useRef(0);
  const preferredFacingModeRef = useRef<CameraFacingMode>("environment");
  const cameraMirroredRef = useRef(false);

  const [modelStatus, setModelStatus] = useState<ModelStatus>("loading");
  const [modelError, setModelError] = useState("");
  const [modelDelegate, setModelDelegate] = useState<"GPU" | "CPU" | null>(null);
  const [mode, setMode] = useState<SessionMode>("ready");
  const [source, setSource] = useState<SessionSource>(null);
  const [cameraError, setCameraError] = useState("");
  const [cameraOptions, setCameraOptions] = useState<CameraOption[]>([]);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [cameraOptics, setCameraOptics] = useState<CameraOptics | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisFrame | null>(null);
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [calibration, setCalibration] = useState<CalibrationProfile | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [calibrationMessage, setCalibrationMessage] = useState("");
  const [clipBusy, setClipBusy] = useState(false);

  const getNextEngineTimestamp = useCallback(() => {
    const next = Math.max(performance.now(), engineTimestampRef.current + 0.01);
    engineTimestampRef.current = next;
    return next;
  }, []);

  const updateMode = useCallback((nextMode: SessionMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
  }, []);

  const releaseMatchingFrame = useCallback(
    (worker: Worker, channel: InFlightFrame["channel"], jobId: number, frameId: number) => {
      const operation = inFlightRef.current;
      if (
        !operation ||
        operation.worker !== worker ||
        operation.channel !== channel ||
        operation.jobId !== jobId ||
        operation.frameId !== frameId
      ) {
        return false;
      }
      inFlightRef.current = null;
      return true;
    },
    []
  );

  const abandonFrameOperation = useCallback(
    (channel: InFlightFrame["channel"], jobId: number, recoverTransport: boolean) => {
      const operation = inFlightRef.current;
      if (!operation || operation.channel !== channel || operation.jobId !== jobId) {
        return;
      }
      inFlightRef.current = null;
      if (recoverTransport && operation.transferred) {
        restartWorkerRef.current(operation.worker);
      }
    },
    []
  );

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
    let disposed = false;

    const startWorker = () => {
      if (disposed) {
        return;
      }
      modelReadyRef.current = false;
      setModelStatus("loading");
      setModelError("");
      setModelDelegate(null);

      const worker = new Worker(new URL("../workers/poseWorker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;

      const failWorker = (message: string) => {
        if (disposed || workerRef.current !== worker) {
          return;
        }
        activeClipRunRef.current?.cancel(false);
        if (inFlightRef.current?.worker === worker) {
          inFlightRef.current = null;
        }
        modelReadyRef.current = false;
        analyzerRef.current.reset();
        calibrationStartedAtRef.current = 0;
        calibrationSamplesRef.current = [];
        setAnalysis(null);
        setIsCalibrating(false);
        setCalibrationProgress(0);
        setModelDelegate(null);
        setModelStatus("error");
        setModelError(message);
        setClipBusy(false);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        workerRef.current = null;
      };

      worker.onmessage = (event: MessageEvent<PoseWorkerResponse>) => {
        if (disposed || workerRef.current !== worker) {
          return;
        }
        const message = event.data;

        if (message.type === "ready") {
          modelReadyRef.current = true;
          setModelDelegate(message.delegate);
          setModelStatus("ready");
          setModelError("");
          return;
        }

        if (message.type === "error") {
          const matchedFrame =
            message.channel !== null &&
            message.jobId !== null &&
            message.frameId !== null &&
            releaseMatchingFrame(worker, message.channel, message.jobId, message.frameId);
          if (message.channel === "clip" && matchedFrame) {
            const waiter = clipFrameWaiterRef.current;
            if (waiter && waiter.jobId === message.jobId && waiter.frameId === message.frameId) {
              clipFrameWaiterRef.current = null;
              waiter.reject(new Error(message.message));
            }
          }
          if (message.fatal) {
            failWorker(message.message);
          }
          return;
        }

        if (!releaseMatchingFrame(worker, message.channel, message.jobId, message.frameId)) {
          return;
        }
        if (message.channel === "clip") {
          const waiter = clipFrameWaiterRef.current;
          if (waiter && waiter.jobId === message.jobId && waiter.frameId === message.frameId) {
            clipFrameWaiterRef.current = null;
            waiter.resolve(message);
          }
          return;
        }

        if (
          modeRef.current !== "live" ||
          message.jobId !== liveJobIdRef.current
        ) {
          return;
        }
        const canvas = overlayRef.current;
        const video = videoRef.current;

        if (!isFinitePose(message.landmarks, message.worldLandmarks)) {
          if (performance.now() - lastPoseAtRef.current > LOST_POSE_TIMEOUT_MS) {
            setAnalysis(null);
            if (canvas && video) {
              drawPoseOverlay(canvas, video, null, cameraMirroredRef.current, anatomyLayersRef.current);
            }
          }
          return;
        }

        const poseFrame: PoseFrame = {
          timestamp: message.sourceTimestamp,
          landmarks: message.landmarks!,
          worldLandmarks: message.worldLandmarks!
        };
        lastPoseAtRef.current = performance.now();

        if (calibrationStartedAtRef.current > 0) {
          calibrationSamplesRef.current.push(poseFrame);
          const elapsed = message.sourceTimestamp - calibrationStartedAtRef.current;
          const sampleProgress = calibrationSamplesRef.current.length / MIN_CALIBRATION_SAMPLES;
          const timeProgress = elapsed / MIN_CALIBRATION_MS;
          const progress = Math.max(0, Math.min(1, sampleProgress, timeProgress));
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
            drawPoseOverlay(
              canvas,
              video,
              nextAnalysis,
              cameraMirroredRef.current,
              anatomyLayersRef.current
            );
          }

          if (message.sourceTimestamp - lastUiUpdateRef.current >= 100) {
            setAnalysis(nextAnalysis);
            setInferenceMs(message.inferenceMs);
            lastUiUpdateRef.current = message.sourceTimestamp;
          }
        } catch {
          if (performance.now() - lastPoseAtRef.current > LOST_POSE_TIMEOUT_MS) {
            setAnalysis(null);
          }
        }
      };

      worker.onerror = () => {
        failWorker("The background pose engine stopped unexpectedly.");
      };

      worker.postMessage({ type: "initialize" });
    };

    restartWorkerRef.current = (expectedWorker) => {
      if (disposed) {
        return;
      }
      if (expectedWorker && workerRef.current !== expectedWorker) {
        return;
      }
      const worker = workerRef.current;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
      workerRef.current = null;
      startWorker();
    };

    startWorker();

    return () => {
      disposed = true;
      restartWorkerRef.current = () => undefined;
      activeClipRunRef.current?.cancel(false);
      inFlightRef.current = null;
      modelReadyRef.current = false;
      const worker = workerRef.current;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        try {
          worker.postMessage({ type: "close" });
        } finally {
          worker.terminate();
        }
      }
      workerRef.current = null;
    };
  }, [releaseMatchingFrame]);

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
    const endingLiveJobId = liveJobIdRef.current;
    cameraRequestIdRef.current += 1;
    cameraRequestInFlightRef.current = false;
    releaseCamera();
    cancelCalibration();
    analyzerRef.current.reset();
    abandonFrameOperation("live", endingLiveJobId, true);
    liveJobIdRef.current += 1;
    liveFrameIdRef.current = 0;
    liveSourceTimestampRef.current = Number.NEGATIVE_INFINITY;
    setAnalysis(null);
    setInferenceMs(null);
    setCalibrationMessage("");
    setCameraOptions([]);
    setActiveCameraId(null);
    setCameraOptics(null);
    cameraMirroredRef.current = false;
    lastUiUpdateRef.current = 0;
    setSource(null);
    updateMode("ready");
    const canvas = overlayRef.current;
    if (canvas) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [abandonFrameOperation, cancelCalibration, releaseCamera, updateMode]);

  const refreshCameraOptions = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices;
    const stream = streamRef.current;
    if (!stream || !mediaDevices?.enumerateDevices) {
      return;
    }
    const requestId = cameraRequestIdRef.current;
    try {
      const devices = await mediaDevices.enumerateDevices();
      if (cameraRequestIdRef.current !== requestId || streamRef.current !== stream) {
        return;
      }
      const cameras = devices
        .filter((device) => device.kind === "videoinput" && device.deviceId)
        .filter(
          (device, index, all) =>
            all.findIndex((candidate) => candidate.deviceId === device.deviceId) === index
        )
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label.trim() || `Camera ${index + 1}`
        }));
      setCameraOptions(cameras);
      const currentDeviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      if (currentDeviceId) {
        setActiveCameraId(currentDeviceId);
      }
    } catch {
      // The current camera remains usable when device enumeration is unavailable.
    }
  }, []);

  const requestCamera = useCallback(async (
    facingMode: CameraFacingMode,
    selectedDeviceId?: string
  ) => {
    if (cameraRequestInFlightRef.current) {
      return;
    }
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setCameraError("Camera capture is unavailable in this browser.");
      return;
    }

    const requestId = cameraRequestIdRef.current + 1;
    const endingLiveJobId = liveJobIdRef.current;
    cameraRequestIdRef.current = requestId;
    cameraRequestInFlightRef.current = true;
    preferredFacingModeRef.current = facingMode;
    abandonFrameOperation("live", endingLiveJobId, true);
    liveJobIdRef.current += 1;
    liveFrameIdRef.current = 0;
    liveSourceTimestampRef.current = Number.NEGATIVE_INFINITY;
    setSource("camera");
    updateMode("requesting");
    setCameraError("");
    setCalibrationMessage("");
    setAnalysis(null);
    setInferenceMs(null);
    cancelCalibration();
    analyzerRef.current.reset();
    releaseCamera();

    try {
      let usedDeviceFallback = false;
      let stream: MediaStream;
      try {
        stream = await mediaDevices.getUserMedia(cameraConstraints(facingMode, selectedDeviceId));
      } catch (error) {
        if (!selectedDeviceId || !canFallbackFromDeviceError(error)) {
          throw error;
        }
        if (cameraRequestIdRef.current !== requestId) {
          return;
        }
        usedDeviceFallback = true;
        stream = await mediaDevices.getUserMedia(cameraConstraints(facingMode));
      }
      if (cameraRequestIdRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new DOMException("No video track was returned.", "NotFoundError");
      }
      const minimumZoomApplied = await applyMinimumZoom(videoTrack);
      if (cameraRequestIdRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const optics = getCameraOptics(videoTrack, facingMode, minimumZoomApplied);
      cameraMirroredRef.current = optics.mirrored;
      setCameraOptics(optics);
      const settings = videoTrack.getSettings?.() ?? {};
      setActiveCameraId(settings.deviceId ?? (usedDeviceFallback ? null : selectedDeviceId ?? null));
      videoTrack.onended = () => endSession();
      lastUiUpdateRef.current = 0;
      lastPoseAtRef.current = performance.now();
      updateMode("live");

      void refreshCameraOptions();
    } catch (error) {
      if (cameraRequestIdRef.current !== requestId) {
        return;
      }
      releaseCamera();
      setSource(null);
      setCameraOptions([]);
      setCameraOptics(null);
      setActiveCameraId(null);
      cameraMirroredRef.current = false;
      updateMode("ready");
      setCameraError(getCameraErrorMessage(error));
    } finally {
      if (cameraRequestIdRef.current === requestId) {
        cameraRequestInFlightRef.current = false;
      }
    }
  }, [abandonFrameOperation, cancelCalibration, endSession, refreshCameraOptions, releaseCamera, updateMode]);

  const startCamera = useCallback(
    (facingMode: CameraFacingMode = "environment") => requestCamera(facingMode),
    [requestCamera]
  );

  const selectCamera = useCallback(
    (deviceId: string) => {
      if (!deviceId || deviceId === activeCameraId) {
        return;
      }
      void requestCamera(preferredFacingModeRef.current, deviceId);
    },
    [activeCameraId, requestCamera]
  );

  const toggleCameraMirror = useCallback(() => {
    setCameraOptics((current) => {
      if (!current) {
        return current;
      }
      const mirrored = !current.mirrored;
      cameraMirroredRef.current = mirrored;
      return { ...current, mirrored };
    });
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (source !== "camera" || mode !== "live" || !mediaDevices?.addEventListener) {
      return;
    }
    const onDeviceChange = () => void refreshCameraOptions();
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [mode, refreshCameraOptions, source]);

  const startDemo = useCallback(() => {
    cameraRequestIdRef.current += 1;
    cameraRequestInFlightRef.current = false;
    releaseCamera();
    cancelCalibration();
    setCameraError("");
    setCalibrationMessage("");
    setAnalysis(null);
    setCameraOptions([]);
    setActiveCameraId(null);
    setCameraOptics(null);
    cameraMirroredRef.current = false;
    setSource("demo");
    updateMode("demo");
  }, [cancelCalibration, releaseCamera, updateMode]);

  const togglePause = useCallback(() => {
    const currentMode = modeRef.current;
    let nextMode = currentMode;
    if (currentMode === "live" || currentMode === "demo") {
      cancelCalibration();
      nextMode = "paused";
    } else if (currentMode === "paused") {
      if (streamRef.current) {
        abandonFrameOperation("live", liveJobIdRef.current, true);
        nextMode = "live";
      } else {
        nextMode = "demo";
      }
    }
    updateMode(nextMode);
  }, [abandonFrameOperation, cancelCalibration, updateMode]);

  const startCalibration = useCallback(() => {
    if (mode !== "live") {
      return;
    }
    calibrationSamplesRef.current = [];
    calibrationStartedAtRef.current = Math.max(0.001, liveSourceTimestampRef.current);
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

  const cancelClipAnalysis = useCallback(() => {
    activeClipRunRef.current?.cancel();
  }, []);

  const analyzeClip = useCallback(
    ({ video, startTime, endTime, crop, output, onProgress }: ClipAnalysisOptions) => {
      if (!modelReadyRef.current || !workerRef.current) {
        return Promise.reject(new Error("The on-device pose model is not ready yet."));
      }
      if (modeRef.current !== "ready") {
        return Promise.reject(new Error("End the current coaching session before analyzing a clip."));
      }
      if (activeClipRunRef.current) {
        return Promise.reject(new Error("Another clip is already being analyzed."));
      }
      const selectedDuration = endTime - startTime;
      if (
        !Number.isFinite(startTime) ||
        !Number.isFinite(endTime) ||
        endTime <= startTime ||
        selectedDuration < VIDEO_CLIP_LIMITS.minSelectionSeconds ||
        selectedDuration > VIDEO_CLIP_LIMITS.maxSelectionSeconds + 0.001 ||
        startTime < 0 ||
        !Number.isFinite(video.duration) ||
        endTime > video.duration + 0.025
      ) {
        return Promise.reject(new Error("Choose a valid analysis window from 4 to 10 seconds."));
      }
      if (
        !Number.isFinite(video.videoWidth) ||
        !Number.isFinite(video.videoHeight) ||
        video.videoWidth < 1 ||
        video.videoHeight < 1 ||
        video.videoWidth > VIDEO_CLIP_LIMITS.maxSourceDimension ||
        video.videoHeight > VIDEO_CLIP_LIMITS.maxSourceDimension ||
        video.videoWidth * video.videoHeight > VIDEO_CLIP_LIMITS.maxSourcePixels ||
        !Object.values(crop).every(Number.isFinite) ||
        crop.x < 0 ||
        crop.y < 0 ||
        crop.width < VIDEO_CLIP_LIMITS.minNormalizedCropSize ||
        crop.height < VIDEO_CLIP_LIMITS.minNormalizedCropSize ||
        crop.x + crop.width > 1.000001 ||
        crop.y + crop.height > 1.000001
      ) {
        return Promise.reject(new Error("The selected analysis frame is invalid."));
      }
      const sourceCrop = getCropPixels(crop, video.videoWidth, video.videoHeight);
      const expectedOutput = getInferenceDimensions(sourceCrop.width, sourceCrop.height);
      if (
        !Number.isSafeInteger(output.width) ||
        !Number.isSafeInteger(output.height) ||
        output.width !== expectedOutput.width ||
        output.height !== expectedOutput.height
      ) {
        return Promise.reject(new Error("The selected analysis frame has unsafe output dimensions."));
      }

      const worker = workerRef.current;
      const clipSettings = { ...settingsRef.current };
      const jobId = clipJobIdRef.current + 1;
      clipJobIdRef.current = jobId;
      const expectedFrames = Math.max(
        1,
        Math.min(150, Math.ceil((endTime - startTime) * 15))
      );
      const clipAnalyzer = new SwingAnalyzer();
      const samples: ClipAnalysisSample[] = [];
      let processedFrames = 0;
      let supportedFrames = 0;
      let frameId = 0;
      let lastSubmittedAt = Number.NEGATIVE_INFINITY;
      let active = true;
      let settled = false;
      let frameProcessing = false;
      let mediaEnded = false;
      let videoFrameHandle = 0;
      let animationFrameHandle = 0;
      let totalTimeoutHandle = 0;
      let decodeTimeoutHandle = 0;
      let processingTimeoutHandle = 0;
      let rejectPendingSeek: ((error: Error) => void) | null = null;
      let lastDecodedMediaTimeMs = Number.NEGATIVE_INFINITY;
      let lastFallbackMediaTimeMs = Number.NEGATIVE_INFINITY;
      const previousPlaybackRate = video.playbackRate;
      const previousMuted = video.muted;

      setClipBusy(true);
      onProgress({ stage: "preparing", progress: 0.03, processedFrames, expectedFrames });

      return new Promise<ClipAnalysisRunResult>((resolve, reject) => {
        const clearSchedules = () => {
          if (videoFrameHandle && "cancelVideoFrameCallback" in video) {
            video.cancelVideoFrameCallback(videoFrameHandle);
          }
          cancelAnimationFrame(animationFrameHandle);
          window.clearTimeout(totalTimeoutHandle);
          window.clearTimeout(decodeTimeoutHandle);
          window.clearTimeout(processingTimeoutHandle);
          rejectPendingSeek?.(new DOMException("Clip analysis was cancelled.", "AbortError"));
          rejectPendingSeek = null;
          video.removeEventListener("ended", onMediaEnded);
          video.removeEventListener("error", onMediaError);
          videoFrameHandle = 0;
          animationFrameHandle = 0;
          totalTimeoutHandle = 0;
          decodeTimeoutHandle = 0;
          processingTimeoutHandle = 0;
        };

        const cleanup = (recoverTransport: boolean) => {
          active = false;
          clearSchedules();
          video.pause();
          video.playbackRate = previousPlaybackRate;
          video.muted = previousMuted;
          if (activeClipRunRef.current?.jobId === jobId) {
            activeClipRunRef.current = null;
          }
          abandonFrameOperation("clip", jobId, recoverTransport);
          setClipBusy(false);
        };

        const settleError = (error: Error, recoverTransport = true) => {
          if (settled) {
            return;
          }
          settled = true;
          const waiter = clipFrameWaiterRef.current;
          if (waiter?.jobId === jobId) {
            clipFrameWaiterRef.current = null;
            waiter.reject(error);
          }
          cleanup(recoverTransport);
          reject(error);
        };

        const settleSuccess = () => {
          if (settled) {
            return;
          }
          settled = true;
          onProgress({
            stage: "building",
            progress: 1,
            processedFrames,
            expectedFrames
          });
          cleanup(false);
          resolve({ samples, processedFrames, supportedFrames, expectedFrames });
        };

        const finishSelection = () => {
          if (frameProcessing) {
            return;
          }
          if (processedFrames === 0) {
            settleError(new Error("No decodable video frames were found in the selected window."));
            return;
          }
          settleSuccess();
        };

        const finishDecodedSelection = () => {
          if (frameProcessing) {
            return;
          }
          const lastDecodedMediaTime = Number.isFinite(lastDecodedMediaTimeMs)
            ? lastDecodedMediaTimeMs / 1_000
            : Number.NEGATIVE_INFINITY;
          if (endTime - lastDecodedMediaTime > CLIP_END_TOLERANCE_SECONDS) {
            settleError(
              new Error(
                "The video ended before the selected analysis window was complete. The file may be damaged or incomplete."
              )
            );
            return;
          }
          finishSelection();
        };

        const clearDecodeTimeout = () => {
          window.clearTimeout(decodeTimeoutHandle);
          decodeTimeoutHandle = 0;
        };

        const armDecodeTimeout = () => {
          if (decodeTimeoutHandle) {
            return;
          }
          decodeTimeoutHandle = window.setTimeout(() => {
            decodeTimeoutHandle = 0;
            settleError(
              new Error(
                "This browser stopped producing frames from the video. Try a browser-compatible MP4 or WebM clip."
              )
            );
          }, CLIP_DECODE_TIMEOUT_MS);
        };

        const clearProcessingTimeout = () => {
          window.clearTimeout(processingTimeoutHandle);
          processingTimeoutHandle = 0;
        };

        const armProcessingTimeout = (operation: InFlightFrame) => {
          clearProcessingTimeout();
          processingTimeoutHandle = window.setTimeout(() => {
            processingTimeoutHandle = 0;
            const message = operation.transferred
              ? "The pose engine stopped responding while analyzing a video frame."
              : "Extracting a video frame took too long.";
            settleError(new Error(message));
          }, operation.transferred ? CLIP_INFERENCE_TIMEOUT_MS : CLIP_EXTRACTION_TIMEOUT_MS);
        };

        activeClipRunRef.current = {
          jobId,
          cancel: (recoverTransport = true) =>
            settleError(new DOMException("Clip analysis was cancelled.", "AbortError"), recoverTransport)
        };

        const submitFrame = async (sourceTimestamp: number) => {
          if (!active || inFlightRef.current || !workerRef.current) {
            return;
          }

          const currentFrameId = frameId;
          frameId += 1;
          const operation: InFlightFrame = {
            channel: "clip",
            jobId,
            frameId: currentFrameId,
            worker,
            transferred: false
          };
          frameProcessing = true;
          inFlightRef.current = operation;
          armProcessingTimeout(operation);

          let frame: ImageBitmap | null = null;
          try {
            frame = await createImageBitmap(video, sourceCrop.x, sourceCrop.y, sourceCrop.width, sourceCrop.height, {
              resizeWidth: Math.round(output.width),
              resizeHeight: Math.round(output.height),
              resizeQuality: "medium"
            });
            if (
              !active ||
              workerRef.current !== worker ||
              inFlightRef.current !== operation
            ) {
              frame.close();
              if (inFlightRef.current === operation) {
                inFlightRef.current = null;
              }
              return;
            }

            const request: PoseWorkerFrameRequest = {
              type: "frame",
              channel: "clip",
              jobId,
              frameId: currentFrameId,
              frame,
              engineTimestamp: getNextEngineTimestamp(),
              sourceTimestamp
            };
            const result = await new Promise<PoseWorkerResultMessage>((resolveFrame, rejectFrame) => {
              clipFrameWaiterRef.current = {
                jobId,
                frameId: currentFrameId,
                resolve: resolveFrame,
                reject: rejectFrame
              };
              try {
                worker.postMessage(request, [request.frame]);
                operation.transferred = true;
                // Extraction and Worker inference are separate bounded phases.
                // Re-arm here so a slow-but-valid extraction does not consume
                // the cold inference budget on software-rendered browsers.
                armProcessingTimeout(operation);
              } catch (error) {
                clipFrameWaiterRef.current = null;
                rejectFrame(error instanceof Error ? error : new Error("The video frame could not be transferred."));
              }
            });
            clearProcessingTimeout();

            if (!active) {
              return;
            }
            processedFrames += 1;
            if (result.poseCount === 1 && isFinitePose(result.landmarks, result.worldLandmarks)) {
              const analysisFrame = clipAnalyzer.update(
                {
                  timestamp: result.sourceTimestamp,
                  landmarks: result.landmarks!,
                  worldLandmarks: result.worldLandmarks!
                },
                clipSettings,
                null
              );
              samples.push({ sourceTimestamp: result.sourceTimestamp, analysis: analysisFrame });
              supportedFrames += 1;
            }

            const mediaProgress = Math.min(
              1,
              Math.max(0, (result.sourceTimestamp / 1_000 - startTime) / selectedDuration)
            );
            onProgress({
              stage: mediaProgress < 0.52 ? "finding" : "checking",
              progress: 0.1 + mediaProgress * 0.82,
              processedFrames,
              expectedFrames
            });
          } catch (error) {
            if (frame && !operation.transferred) {
              frame.close();
            }
            if (inFlightRef.current === operation) {
              inFlightRef.current = null;
            }
            if (active) {
              settleError(
                error instanceof Error ? error : new Error("A video frame could not be analyzed.")
              );
            }
          } finally {
            clearProcessingTimeout();
            frameProcessing = false;
          }
        };

        function onMediaEnded() {
          if (!active) {
            return;
          }
          clearDecodeTimeout();
          mediaEnded = true;
          finishDecodedSelection();
        }

        function onMediaError() {
          if (!active) {
            return;
          }
          settleError(new Error(getVideoMediaErrorMessage(video.error)));
        }

        const scheduleFrame = () => {
          if (!active || mediaEnded || video.ended) {
            if (video.ended) {
              onMediaEnded();
            }
            return;
          }
          if (typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function") {
            videoFrameHandle = video.requestVideoFrameCallback((_now, metadata) => {
              videoFrameHandle = 0;
              clearDecodeTimeout();
              void handleDecodedFrame(metadata.mediaTime * 1_000, true);
            });
          } else {
            animationFrameHandle = requestAnimationFrame(() => {
              animationFrameHandle = 0;
              void handleDecodedFrame(video.currentTime * 1_000, false);
            });
          }
          armDecodeTimeout();
        };

        const handleDecodedFrame = async (mediaTimeMs: number, isPresentedFrame: boolean) => {
          if (!active) {
            return;
          }
          const previousMediaTimeMs = isPresentedFrame
            ? lastDecodedMediaTimeMs
            : lastFallbackMediaTimeMs;
          const hasAdvanced =
            Number.isFinite(mediaTimeMs) && mediaTimeMs > previousMediaTimeMs + 0.1;
          if (!isPresentedFrame && !hasAdvanced && !video.ended) {
            scheduleFrame();
            return;
          }
          clearDecodeTimeout();
          if (!Number.isFinite(mediaTimeMs)) {
            scheduleFrame();
            return;
          }
          if (isPresentedFrame) {
            lastDecodedMediaTimeMs = Math.max(lastDecodedMediaTimeMs, mediaTimeMs);
          } else {
            if (
              Number.isFinite(lastFallbackMediaTimeMs) &&
              mediaTimeMs - lastFallbackMediaTimeMs > CLIP_END_TOLERANCE_SECONDS * 1_000
            ) {
              settleError(
                new Error(
                  "Video playback skipped too far between frames. The file may be damaged or playback may have been interrupted."
                )
              );
              return;
            }
            lastFallbackMediaTimeMs = Math.max(lastFallbackMediaTimeMs, mediaTimeMs);
          }
          const endTimeMs = endTime * 1_000;
          if (mediaTimeMs >= endTimeMs || video.ended) {
            if (video.ended) {
              onMediaEnded();
            } else {
              finishDecodedSelection();
            }
            return;
          }
          if (mediaTimeMs + 25 < startTime * 1_000) {
            scheduleFrame();
            return;
          }
          if (mediaTimeMs - lastSubmittedAt >= CLIP_SAMPLE_INTERVAL_MS) {
            lastSubmittedAt = mediaTimeMs;
            // Hold source time while one sampled frame is extracted and inferred.
            // This keeps submitted timestamps within SwingAnalyzer's continuity
            // window on slow devices without creating a pending-frame queue.
            video.pause();
            await submitFrame(mediaTimeMs);
            if (!active) {
              return;
            }
            if (!isPresentedFrame) {
              lastDecodedMediaTimeMs = Math.max(lastDecodedMediaTimeMs, mediaTimeMs);
            }
            if (mediaEnded || video.ended) {
              onMediaEnded();
              return;
            }
            try {
              await video.play();
            } catch {
              settleError(new Error("The selected clip could not continue playing."));
              return;
            }
          }
          scheduleFrame();
        };

        const begin = async () => {
          try {
            video.addEventListener("ended", onMediaEnded);
            video.addEventListener("error", onMediaError);
            video.pause();
            if (Math.abs(video.currentTime - startTime) > 0.025) {
              await new Promise<void>((resolveSeek, rejectSeek) => {
                let seekTimeout = 0;
                let seekSettled = false;
                const removeListeners = () => {
                  video.removeEventListener("seeked", onSeeked);
                  window.clearTimeout(seekTimeout);
                  rejectPendingSeek = null;
                };
                const settleSeek = (callback: () => void) => {
                  if (seekSettled) {
                    return;
                  }
                  seekSettled = true;
                  removeListeners();
                  callback();
                };
                const onSeeked = () => {
                  settleSeek(resolveSeek);
                };
                video.addEventListener("seeked", onSeeked, { once: true });
                rejectPendingSeek = (error) => settleSeek(() => rejectSeek(error));
                seekTimeout = window.setTimeout(() => {
                  settleSeek(() => rejectSeek(new Error("Seeking the selected video window timed out.")));
                }, CLIP_DECODE_TIMEOUT_MS);
                video.currentTime = startTime;
              });
            }
            if (!active) {
              return;
            }
            video.muted = true;
            video.playbackRate = modelDelegate === "CPU" ? 2 : 4;
            onProgress({ stage: "finding", progress: 0.1, processedFrames, expectedFrames });
            totalTimeoutHandle = window.setTimeout(() => {
              settleError(new Error("Analysis took too long. Try a tighter frame or shorter selection."));
            }, CLIP_TOTAL_TIMEOUT_MS);
            await video.play();
            if (!active) {
              return;
            }
            scheduleFrame();
          } catch (error) {
            settleError(
              error instanceof Error ? error : new Error("The selected clip could not be played.")
            );
          }
        };

        void begin();
      });
    },
    [abandonFrameOperation, getNextEngineTimestamp, modelDelegate]
  );

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
    const jobId = liveJobIdRef.current;
    const syncVideoDimensions = () => {
      if (!active || video.videoWidth < 1 || video.videoHeight < 1) {
        return;
      }
      setCameraOptics((current) => current ? {
        ...current,
        width: video.videoWidth,
        height: video.videoHeight,
        aspectRatio: video.videoWidth / video.videoHeight
      } : current);
    };
    video.addEventListener("loadedmetadata", syncVideoDimensions);
    video.addEventListener("resize", syncVideoDimensions);

    const submitFrame = async (sourceTimestamp: number) => {
      if (!active || inFlightRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      if (!Number.isFinite(sourceTimestamp) || sourceTimestamp <= liveSourceTimestampRef.current) {
        return;
      }

      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      const currentFrameId = liveFrameIdRef.current;
      liveFrameIdRef.current += 1;
      const operation: InFlightFrame = {
        channel: "live",
        jobId,
        frameId: currentFrameId,
        worker,
        transferred: false
      };
      inFlightRef.current = operation;
      let frame: ImageBitmap | null = null;
      try {
        frame = await createImageBitmap(video);
        if (
          !active ||
          workerRef.current !== worker ||
          inFlightRef.current !== operation
        ) {
          frame.close();
          if (inFlightRef.current === operation) {
            inFlightRef.current = null;
          }
          return;
        }
        liveSourceTimestampRef.current = sourceTimestamp;
        const request: PoseWorkerFrameRequest = {
          type: "frame",
          channel: "live",
          jobId,
          frameId: currentFrameId,
          frame,
          engineTimestamp: getNextEngineTimestamp(),
          sourceTimestamp
        };
        worker.postMessage(request, [frame]);
        operation.transferred = true;
      } catch {
        if (frame && !operation.transferred) {
          frame.close();
        }
        if (inFlightRef.current === operation) {
          inFlightRef.current = null;
        }
      }
    };

    const scheduleVideoFrame = () => {
      if (!active) {
        return;
      }
      if ("requestVideoFrameCallback" in video) {
        videoFrameHandle = video.requestVideoFrameCallback((_now, metadata) => {
          void submitFrame(metadata.mediaTime * 1_000);
          scheduleVideoFrame();
        });
      } else {
        animationFrameHandle = requestAnimationFrame((now) => {
          void submitFrame(now);
          scheduleVideoFrame();
        });
      }
    };

    void video.play().then(scheduleVideoFrame).catch(() => {
      if (!active) {
        return;
      }
      cameraRequestIdRef.current += 1;
      releaseCamera();
      setSource(null);
      setCameraOptions([]);
      setActiveCameraId(null);
      setCameraOptics(null);
      cameraMirroredRef.current = false;
      updateMode("ready");
      setCameraError("The camera feed could not start. Check camera access and try again.");
    });
    return () => {
      active = false;
      video.removeEventListener("loadedmetadata", syncVideoDimensions);
      video.removeEventListener("resize", syncVideoDimensions);
      if (videoFrameHandle && "cancelVideoFrameCallback" in video) {
        video.cancelVideoFrameCallback(videoFrameHandle);
      }
      cancelAnimationFrame(animationFrameHandle);
      const operation = inFlightRef.current;
      if (
        operation?.channel === "live" &&
        operation.jobId === jobId &&
        !operation.transferred
      ) {
        inFlightRef.current = null;
      }
    };
  }, [abandonFrameOperation, getNextEngineTimestamp, mode, modelStatus, releaseCamera, updateMode]);

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
    cameraOptions,
    activeCameraId,
    cameraOptics,
    analysis,
    inferenceMs,
    calibration,
    isCalibrating,
    calibrationProgress,
    calibrationMessage,
    clipBusy,
    startCamera,
    selectCamera,
    toggleCameraMirror,
    refreshCameraOptions,
    startDemo,
    togglePause,
    endSession,
    startCalibration,
    resetCalibration,
    analyzeClip,
    cancelClipAnalysis
  };
}
