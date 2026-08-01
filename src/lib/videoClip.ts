import type { AnalysisFrame } from "../types";

const MEBIBYTE = 1024 * 1024;

export const VIDEO_CLIP_LIMITS = {
  maxFileBytes: 200 * MEBIBYTE,
  maxBytes: 200 * MEBIBYTE,
  maxSourceDurationSeconds: 120,
  maxSourceSeconds: 120,
  maxSourceDimension: 4096,
  maxSourcePixels: 8_300_000,
  maxTrimSeconds: 10,
  maxSelectionSeconds: 10,
  minTrimSeconds: 4,
  minSelectionSeconds: 4,
  minNormalizedCropSize: 0.2,
  maxInferenceLongEdge: 640
} as const;

export const VIDEO_CLIP_SUPPORTED_EXTENSIONS = [".mp4", ".webm", ".mov"] as const;
export const VIDEO_CLIP_SUPPORTED_MIME_HINTS = [
  "video/mp4",
  "video/webm",
  "video/quicktime"
] as const;

const supportedExtensions = new Set<string>(VIDEO_CLIP_SUPPORTED_EXTENSIONS);
const supportedMimeHints = new Set<string>(VIDEO_CLIP_SUPPORTED_MIME_HINTS);

export type VideoClipMetadata = {
  duration: number;
  width: number;
  height: number;
};

export type VideoTrimRange = {
  start: number;
  end: number;
};

export type NormalizedCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SourceCropPixels = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InferenceDimensions = {
  width: number;
  height: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedMimeHint(type: string): string {
  return type.split(";", 1)[0].trim().toLowerCase();
}

function filenameExtension(name: string): string {
  const match = /\.[a-z0-9]+$/i.exec(name.trim());
  return match?.[0].toLowerCase() ?? "";
}

/**
 * Performs a cheap resource and format-hint check before an object URL is made.
 * A successful result never proves that the bytes are a valid video; the native
 * browser decoder remains the authority.
 */
export function validateVideoFile(file: File): string | null {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "Choose a video file that is not empty.";
  }
  if (file.size > VIDEO_CLIP_LIMITS.maxFileBytes) {
    return "Choose a video smaller than 200 MB.";
  }

  const extensionLooksSupported = supportedExtensions.has(filenameExtension(file.name));
  const mimeHint = normalizedMimeHint(file.type);
  const mimeLooksSupported = supportedMimeHints.has(mimeHint);

  if (!extensionLooksSupported && !mimeLooksSupported) {
    return "Choose an MP4, WebM, or MOV video.";
  }

  return null;
}

export function validateVideoMetadata({ duration, width, height }: VideoClipMetadata): string | null {
  if (
    !Number.isFinite(duration) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    duration <= 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return "This video's metadata could not be read safely.";
  }
  if (duration > VIDEO_CLIP_LIMITS.maxSourceDurationSeconds) {
    return "Choose a video no longer than 2 minutes.";
  }
  if (duration < VIDEO_CLIP_LIMITS.minSelectionSeconds) {
    return "Choose a video at least 4 seconds long so three full swings can be assessed.";
  }
  if (
    width > VIDEO_CLIP_LIMITS.maxSourceDimension ||
    height > VIDEO_CLIP_LIMITS.maxSourceDimension
  ) {
    return "Choose a video no larger than 4096 px on either side.";
  }
  if (width * height > VIDEO_CLIP_LIMITS.maxSourcePixels) {
    return "Choose a video at or below 8.3 megapixels.";
  }

  return null;
}

/**
 * Returns a bounded range. `changed` keeps the user's active handle anchored
 * whenever the source boundaries allow it.
 */
export function clampTrimRange(
  start: number,
  end: number,
  duration: number | null | undefined,
  changed?: "start" | "end"
): VideoTrimRange {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return { start: 0, end: 0 };
  }

  const maxSpan = Math.min(VIDEO_CLIP_LIMITS.maxTrimSeconds, duration);
  const minSpan = Math.min(VIDEO_CLIP_LIMITS.minTrimSeconds, duration);
  const safeStart = Number.isFinite(start) ? clamp(start, 0, duration) : 0;
  const safeEnd = Number.isFinite(end)
    ? clamp(end, 0, duration)
    : Math.min(duration, safeStart + maxSpan);

  if (changed === "start") {
    const span = clamp(safeEnd - safeStart, minSpan, maxSpan);
    let nextStart = safeStart;
    let nextEnd = nextStart + span;
    if (nextEnd > duration) {
      nextEnd = duration;
      nextStart = Math.max(0, nextEnd - span);
    }
    return { start: nextStart, end: nextEnd };
  }

  if (changed === "end") {
    const span = clamp(safeEnd - safeStart, minSpan, maxSpan);
    let nextEnd = safeEnd;
    let nextStart = nextEnd - span;
    if (nextStart < 0) {
      nextStart = 0;
      nextEnd = Math.min(duration, nextStart + span);
    }
    return { start: nextStart, end: nextEnd };
  }

  let nextStart = Math.min(safeStart, safeEnd);
  let nextEnd = Math.max(safeStart, safeEnd);
  const span = clamp(nextEnd - nextStart, minSpan, maxSpan);
  nextEnd = nextStart + span;
  if (nextEnd > duration) {
    nextEnd = duration;
    nextStart = Math.max(0, nextEnd - span);
  }
  return { start: nextStart, end: nextEnd };
}

export function clampCropRect(rect: NormalizedCropRect): NormalizedCropRect {
  const width = Number.isFinite(rect.width)
    ? clamp(rect.width, VIDEO_CLIP_LIMITS.minNormalizedCropSize, 1)
    : 1;
  const height = Number.isFinite(rect.height)
    ? clamp(rect.height, VIDEO_CLIP_LIMITS.minNormalizedCropSize, 1)
    : 1;
  const x = Number.isFinite(rect.x) ? clamp(rect.x, 0, 1 - width) : 0;
  const y = Number.isFinite(rect.y) ? clamp(rect.y, 0, 1 - height) : 0;

  return { x, y, width, height };
}

function finiteSourceDimension(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Source dimensions must be finite positive numbers.");
  }
  return Math.floor(value);
}

export function getCropPixels(
  rect: NormalizedCropRect,
  sourceWidth: number,
  sourceHeight: number
): SourceCropPixels {
  const width = finiteSourceDimension(sourceWidth);
  const height = finiteSourceDimension(sourceHeight);
  const crop = clampCropRect(rect);
  const x = Math.floor(crop.x * width);
  const y = Math.floor(crop.y * height);
  const right = Math.min(width, Math.max(x + 1, Math.ceil((crop.x + crop.width) * width)));
  const bottom = Math.min(height, Math.max(y + 1, Math.ceil((crop.y + crop.height) * height)));

  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

export function getInferenceDimensions(
  sourceCropWidth: number,
  sourceCropHeight: number
): InferenceDimensions {
  const width = finiteSourceDimension(sourceCropWidth);
  const height = finiteSourceDimension(sourceCropHeight);
  const scale = Math.min(1, VIDEO_CLIP_LIMITS.maxInferenceLongEdge / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function mapNormalizedCoordinate(value: number, offset: number, span: number): number {
  const mapped = Number.isFinite(value) ? offset + value * span : offset;
  return clamp(mapped, 0, 1);
}

/** Maps image-space results back into the full source frame without changing world-space data. */
export function mapAnalysisToSource(
  analysis: AnalysisFrame,
  rect: NormalizedCropRect
): AnalysisFrame {
  const crop = clampCropRect(rect);

  return {
    ...analysis,
    landmarks: analysis.landmarks.map((landmark) => ({
      ...landmark,
      x: mapNormalizedCoordinate(landmark.x, crop.x, crop.width),
      y: mapNormalizedCoordinate(landmark.y, crop.y, crop.height)
    })),
    jointRisks: analysis.jointRisks.map((risk) => ({
      ...risk,
      center: {
        x: mapNormalizedCoordinate(risk.center.x, crop.x, crop.width),
        y: mapNormalizedCoordinate(risk.center.y, crop.y, crop.height)
      }
    }))
  };
}
