import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import type { AnalysisFrame } from "../../types";
import {
  VIDEO_CLIP_LIMITS,
  clampCropRect,
  clampTrimRange,
  getCropPixels,
  getInferenceDimensions,
  getVideoMediaErrorMessage,
  mapAnalysisToSource,
  validateVideoFile,
  validateVideoMetadata,
  type NormalizedCropRect
} from "../videoClip";

function videoFile(name: string, type = "video/mp4", size = 16): File {
  return new File([new Uint8Array(size)], name, { type });
}

function analysisFrame(): AnalysisFrame {
  const landmarks: NormalizedLandmark[] = [
    { x: 0, y: 0, z: -0.2, visibility: 0.9 },
    { x: 0.5, y: 0.25, z: 0.4, visibility: 0.8 },
    { x: 1.2, y: -0.2, z: 0.7, visibility: 0.7 }
  ];
  const worldLandmarks: Landmark[] = [{ x: 1.1, y: -0.4, z: 2.2, visibility: 0.9 }];

  return {
    assessmentStatus: "assessed",
    phase: "drive",
    repCount: 2,
    score: 81,
    confidence: 0.88,
    metrics: {
      hipAngle: 120,
      kneeAngle: 150,
      hipFlexionDelta: 45,
      kneeFlexionDelta: 20,
      hingeRatio: 0.7,
      torsoLean: 34,
      shoulderLift: 0.2,
      wristHeight: 0.4,
      wristDepth: 0.1,
      spineStack: 0.8,
      visibility: 0.9,
      cameraQuality: 0.85,
      smoothness: 0.75,
      depthTravel: 0.3,
      repVelocity: 1.2
    },
    feedback: [
      { id: "hips", label: "Drive through the hips", detail: "Keep the hinge clear.", severity: "good", score: 0.9 }
    ],
    jointRisks: [
      {
        index: 23,
        center: { x: 0.25, y: 0.75 },
        depth: 0.1,
        radius: 0.08,
        intensity: 0.6,
        color: "#fff"
      }
    ],
    worldLandmarks,
    landmarks,
    wristTrail: [
      { x: -0.4, y: 1.2, z: 0.3 },
      { x: 0.2, y: 0.8, z: -0.1 }
    ]
  };
}

describe("validateVideoFile", () => {
  it.each(["swing.mp4", "SWING.WEBM", "session.MOV"])(
    "accepts a supported filename hint with blank MIME: %s",
    (name) => {
      expect(validateVideoFile(videoFile(name, ""))).toBeNull();
    }
  );

  it("accepts a supported MIME hint without relying on a filename extension", () => {
    expect(validateVideoFile(videoFile("camera-export", "video/quicktime"))).toBeNull();
  });

  it("accepts a supported extension when a generic MIME hint is supplied", () => {
    expect(validateVideoFile(videoFile("swing.mp4", "application/octet-stream"))).toBeNull();
  });

  it.each([
    ["photo.jpg", "image/jpeg"],
    ["clip.avi", "video/x-msvideo"],
    ["no-extension", ""]
  ])("rejects a clearly unsupported file hint: %s", (name, type) => {
    expect(validateVideoFile(videoFile(name, type))).toMatch(/MP4, WebM, or MOV/);
  });

  it("rejects an empty file before format handling", () => {
    expect(validateVideoFile(videoFile("empty.mp4", "video/mp4", 0))).toMatch(/not empty/);
  });

  it("enforces the file-size boundary", () => {
    const atLimit = { name: "swing.mp4", type: "video/mp4", size: VIDEO_CLIP_LIMITS.maxFileBytes } as File;
    const overLimit = { ...atLimit, size: VIDEO_CLIP_LIMITS.maxFileBytes + 1 } as File;

    expect(validateVideoFile(atLimit)).toBeNull();
    expect(validateVideoFile(overLimit)).toMatch(/smaller than 200 MB/);
  });
});

describe("getVideoMediaErrorMessage", () => {
  it.each([
    [1, "loading or playback was interrupted"],
    [2, "could not be read"],
    [3, "damaged or uses a codec"],
    [4, "does not support"]
  ])("maps native MediaError code %i to useful guidance", (code, message) => {
    expect(getVideoMediaErrorMessage({ code })).toContain(message);
  });

  it("uses a safe fallback when the browser supplies no error code", () => {
    expect(getVideoMediaErrorMessage(null)).toBe("The browser could not decode this video.");
  });
});

describe("validateVideoMetadata", () => {
  it("accepts common landscape and rotated portrait metadata", () => {
    expect(validateVideoMetadata({ duration: 10, width: 1920, height: 1080 })).toBeNull();
    expect(validateVideoMetadata({ duration: 120, width: 2160, height: 3840 })).toBeNull();
  });

  it.each([
    { duration: Number.NaN, width: 1920, height: 1080 },
    { duration: Number.POSITIVE_INFINITY, width: 1920, height: 1080 },
    { duration: 10, width: Number.NaN, height: 1080 },
    { duration: 10, width: 1920, height: Number.NEGATIVE_INFINITY },
    { duration: 0, width: 1920, height: 1080 },
    { duration: 10, width: 0, height: 1080 },
    { duration: 10, width: 1920, height: -1 }
  ])("rejects unreadable finite metadata", (metadata) => {
    expect(validateVideoMetadata(metadata)).toMatch(/metadata could not be read safely/);
  });

  it("rejects duration beyond two minutes", () => {
    expect(validateVideoMetadata({ duration: 120.001, width: 1920, height: 1080 })).toMatch(
      /no longer than 2 minutes/
    );
  });

  it("rejects a source too short to contain the minimum analysis window", () => {
    expect(validateVideoMetadata({ duration: 3.999, width: 1920, height: 1080 })).toMatch(
      /at least 4 seconds/
    );
    expect(validateVideoMetadata({ duration: 4, width: 1920, height: 1080 })).toBeNull();
  });

  it("rejects either dimension beyond 4096 pixels", () => {
    expect(validateVideoMetadata({ duration: 10, width: 4097, height: 100 })).toMatch(/4096 px/);
    expect(validateVideoMetadata({ duration: 10, width: 100, height: 4097 })).toMatch(/4096 px/);
  });

  it("enforces the pixel budget independently of the edge limit", () => {
    expect(validateVideoMetadata({ duration: 10, width: 3840, height: 2160 })).toBeNull();
    expect(validateVideoMetadata({ duration: 10, width: 4096, height: 2160 })).toMatch(/8.3 megapixels/);
  });
});

describe("clampTrimRange", () => {
  it("leaves a valid range unchanged", () => {
    expect(clampTrimRange(3.25, 10.5, 30)).toEqual({ start: 3.25, end: 10.5 });
  });

  it("caps a long unordered or ordered range at ten seconds", () => {
    expect(clampTrimRange(4, 22, 30)).toEqual({ start: 4, end: 14 });
    expect(clampTrimRange(22, 4, 30)).toEqual({ start: 4, end: 14 });
  });

  it("keeps the changed start handle anchored when possible", () => {
    expect(clampTrimRange(8, 8.5, 30, "start")).toEqual({ start: 8, end: 12 });
    expect(clampTrimRange(8, 25, 30, "start")).toEqual({ start: 8, end: 18 });
  });

  it("keeps the changed end handle anchored when possible", () => {
    expect(clampTrimRange(8, 8.5, 30, "end")).toEqual({ start: 4.5, end: 8.5 });
    expect(clampTrimRange(1, 25, 30, "end")).toEqual({ start: 15, end: 25 });
  });

  it("shifts a minimum-length range inside either source boundary", () => {
    expect(clampTrimRange(19.5, 20, 20, "start")).toEqual({ start: 16, end: 20 });
    expect(clampTrimRange(0, 0.5, 20, "end")).toEqual({ start: 0, end: 4 });
  });

  it("uses the whole source when it is shorter than the four-second target", () => {
    expect(clampTrimRange(0.8, 0.9, 1)).toEqual({ start: 0, end: 1 });
  });

  it("recovers safely from non-finite handles and invalid duration", () => {
    expect(clampTrimRange(Number.NaN, Number.POSITIVE_INFINITY, 30)).toEqual({ start: 0, end: 10 });
    expect(clampTrimRange(1, 2, Number.NaN)).toEqual({ start: 0, end: 0 });
    expect(clampTrimRange(1, 2, -5)).toEqual({ start: 0, end: 0 });
  });

  it("always returns an in-bounds four-to-ten-second selection when possible", () => {
    const inputs = [-10, 0, 0.25, 1.9, 2, 5, 10, 17, 25, Number.NaN, Number.POSITIVE_INFINITY];
    for (const start of inputs) {
      for (const end of inputs) {
        for (const changed of [undefined, "start", "end"] as const) {
          const range = clampTrimRange(start, end, 20, changed);
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.end).toBeLessThanOrEqual(20);
          expect(range.end - range.start).toBeGreaterThanOrEqual(VIDEO_CLIP_LIMITS.minSelectionSeconds);
          expect(range.end - range.start).toBeLessThanOrEqual(VIDEO_CLIP_LIMITS.maxSelectionSeconds);
        }
      }
    }
  });
});

describe("clampCropRect", () => {
  it("leaves an in-bounds crop unchanged", () => {
    expect(clampCropRect({ x: 0.1, y: 0.2, width: 0.6, height: 0.5 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.6,
      height: 0.5
    });
  });

  it("enforces minimum size and keeps the crop within the source", () => {
    expect(clampCropRect({ x: 0.95, y: -0.5, width: 0.01, height: -2 })).toEqual({
      x: 0.8,
      y: 0,
      width: VIDEO_CLIP_LIMITS.minNormalizedCropSize,
      height: VIDEO_CLIP_LIMITS.minNormalizedCropSize
    });
  });

  it("uses safe defaults for non-finite values", () => {
    expect(
      clampCropRect({
        x: Number.NaN,
        y: Number.POSITIVE_INFINITY,
        width: Number.NaN,
        height: Number.NEGATIVE_INFINITY
      })
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("always returns a normalized crop for hostile numeric input", () => {
    const rects: NormalizedCropRect[] = [
      { x: -4, y: 8, width: 9, height: 9 },
      { x: 1, y: 1, width: 0, height: 0 },
      { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }
    ];

    for (const rect of rects) {
      const crop = clampCropRect(rect);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.width).toBeGreaterThanOrEqual(VIDEO_CLIP_LIMITS.minNormalizedCropSize);
      expect(crop.height).toBeGreaterThanOrEqual(VIDEO_CLIP_LIMITS.minNormalizedCropSize);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1);
    }
  });
});

describe("crop and inference dimensions", () => {
  it("converts a normalized crop to contained integer source pixels", () => {
    expect(getCropPixels({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 }, 1920, 1080)).toEqual({
      x: 480,
      y: 108,
      width: 960,
      height: 864
    });
  });

  it("rounds outward so fractional crop edges retain their source pixels", () => {
    const pixels = getCropPixels({ x: 0.333, y: 0.111, width: 0.222, height: 0.333 }, 101, 99);
    expect(pixels).toEqual({ x: 33, y: 10, width: 24, height: 34 });
    expect(Number.isInteger(pixels.x)).toBe(true);
    expect(Number.isInteger(pixels.y)).toBe(true);
    expect(pixels.x + pixels.width).toBeLessThanOrEqual(101);
    expect(pixels.y + pixels.height).toBeLessThanOrEqual(99);
  });

  it("rejects invalid source dimensions", () => {
    expect(() => getCropPixels({ x: 0, y: 0, width: 1, height: 1 }, 0, 1080)).toThrow(RangeError);
    expect(() => getCropPixels({ x: 0, y: 0, width: 1, height: 1 }, 1920, Number.NaN)).toThrow(
      RangeError
    );
  });

  it.each([
    [1920, 1080, 640, 360],
    [1080, 1920, 360, 640],
    [640, 640, 640, 640],
    [320, 180, 320, 180],
    [1, 1920, 1, 640]
  ])("fits %sx%s within a 640px long edge", (width, height, expectedWidth, expectedHeight) => {
    expect(getInferenceDimensions(width, height)).toEqual({
      width: expectedWidth,
      height: expectedHeight
    });
  });

  it("rejects invalid inference dimensions", () => {
    expect(() => getInferenceDimensions(-1, 1080)).toThrow(RangeError);
    expect(() => getInferenceDimensions(1920, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("mapAnalysisToSource", () => {
  it("maps image-normalized landmarks and risk centers into the full source frame", () => {
    const source = analysisFrame();
    const mapped = mapAnalysisToSource(source, { x: 0.25, y: 0.1, width: 0.5, height: 0.8 });

    expect(mapped.landmarks[0]).toMatchObject({ x: 0.25, y: 0.1, z: -0.2, visibility: 0.9 });
    expect(mapped.landmarks[1]).toMatchObject({ z: 0.4, visibility: 0.8 });
    expect(mapped.landmarks[1].x).toBeCloseTo(0.5);
    expect(mapped.landmarks[1].y).toBeCloseTo(0.3);
    expect(mapped.landmarks[2]).toMatchObject({ z: 0.7, visibility: 0.7 });
    expect(mapped.landmarks[2].x).toBeCloseTo(0.85);
    expect(mapped.landmarks[2].y).toBe(0);
    expect(mapped.jointRisks[0].center.x).toBeCloseTo(0.375);
    expect(mapped.jointRisks[0].center.y).toBeCloseTo(0.7);
  });

  it("does not mutate input analysis data", () => {
    const source = analysisFrame();
    const originalLandmarks = structuredClone(source.landmarks);
    const originalRisks = structuredClone(source.jointRisks);

    mapAnalysisToSource(source, { x: 0.1, y: 0.2, width: 0.5, height: 0.5 });

    expect(source.landmarks).toEqual(originalLandmarks);
    expect(source.jointRisks).toEqual(originalRisks);
  });

  it("preserves world landmarks and the world-space wrist trail unchanged", () => {
    const source = analysisFrame();
    const mapped = mapAnalysisToSource(source, { x: 0.2, y: 0.2, width: 0.5, height: 0.5 });

    expect(mapped.worldLandmarks).toBe(source.worldLandmarks);
    expect(mapped.worldLandmarks).toEqual(source.worldLandmarks);
    expect(mapped.wristTrail).toBe(source.wristTrail);
    expect(mapped.wristTrail).toEqual([
      { x: -0.4, y: 1.2, z: 0.3 },
      { x: 0.2, y: 0.8, z: -0.1 }
    ]);
  });

  it("clamps the crop before mapping", () => {
    const mapped = mapAnalysisToSource(analysisFrame(), {
      x: 0.95,
      y: 0.95,
      width: 0.01,
      height: 0.01
    });

    expect(mapped.landmarks[0]).toMatchObject({ x: 0.8, y: 0.8 });
    expect(mapped.landmarks[1].x).toBeCloseTo(0.9);
    expect(mapped.landmarks[1].y).toBeCloseTo(0.85);
  });
});
