import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";

export type Vec2 = {
  x: number;
  y: number;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale3(v: Vec3, scale: number): Vec3 {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function distance3(a: Vec3, b: Vec3): number {
  return length3(sub3(a, b));
}

export function normalize3(v: Vec3): Vec3 {
  const length = length3(v);
  if (length < 1e-6) {
    return { x: 0, y: 0, z: 0 };
  }
  return scale3(v, 1 / length);
}

export function midpoint3(a: Vec3, b: Vec3): Vec3 {
  return scale3(add3(a, b), 0.5);
}

export function midpoint2(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function length2(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function angleBetween2(a: Vec2, b: Vec2): number {
  const denominator = length2(a) * length2(b);
  if (denominator < 1e-6) {
    return 0;
  }
  return toDegrees(Math.acos(clamp(dot2(a, b) / denominator, -1, 1)));
}

export function angleBetween(a: Vec3, b: Vec3): number {
  const denominator = length3(a) * length3(b);
  if (denominator < 1e-6) {
    return 0;
  }
  return toDegrees(Math.acos(clamp(dot3(a, b) / denominator, -1, 1)));
}

export function jointAngle(a: Vec3, vertex: Vec3, c: Vec3): number {
  return angleBetween(sub3(a, vertex), sub3(c, vertex));
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

export function asVec3(landmark: Landmark): Vec3 {
  return { x: landmark.x, y: landmark.y, z: landmark.z };
}

export function asVec2(landmark: NormalizedLandmark): Vec2 {
  return { x: landmark.x, y: landmark.y };
}

export function visibilityOf(landmarks: Array<Landmark | NormalizedLandmark>, indices: number[]): number {
  const values = indices
    .map((index) => landmarks[index]?.visibility ?? 0)
    .filter((value) => Number.isFinite(value));
  return clamp(mean(values), 0, 1);
}

export function directionAngleFromVertical(vector: Vec3): number {
  const vertical = { x: 0, y: -1, z: 0 };
  return angleBetween(vector, vertical);
}

export function directionAngleFromScreenVertical(vector: Vec2): number {
  return angleBetween2(vector, { x: 0, y: -1 });
}
