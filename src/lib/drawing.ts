import type { AnalysisFrame, AnatomyLayerState } from "../types";
import { COACH_JOINTS, POSE } from "./landmarks";

type ScreenPoint = {
  x: number;
  y: number;
  visibility: number;
};

type Segment = {
  from: number;
  to: number;
  width: number;
};

const defaultLayers: AnatomyLayerState = {
  body: true,
  muscles: true,
  skeleton: true,
  gaussian: true
};

const bodySegments: Segment[] = [
  { from: POSE.leftShoulder, to: POSE.leftElbow, width: 0.034 },
  { from: POSE.leftElbow, to: POSE.leftWrist, width: 0.026 },
  { from: POSE.rightShoulder, to: POSE.rightElbow, width: 0.034 },
  { from: POSE.rightElbow, to: POSE.rightWrist, width: 0.026 },
  { from: POSE.leftHip, to: POSE.leftKnee, width: 0.052 },
  { from: POSE.leftKnee, to: POSE.leftAnkle, width: 0.039 },
  { from: POSE.rightHip, to: POSE.rightKnee, width: 0.052 },
  { from: POSE.rightKnee, to: POSE.rightAnkle, width: 0.039 }
];

const boneSegments: Segment[] = [
  { from: POSE.leftShoulder, to: POSE.rightShoulder, width: 0.018 },
  { from: POSE.leftShoulder, to: POSE.leftElbow, width: 0.016 },
  { from: POSE.leftElbow, to: POSE.leftWrist, width: 0.014 },
  { from: POSE.rightShoulder, to: POSE.rightElbow, width: 0.016 },
  { from: POSE.rightElbow, to: POSE.rightWrist, width: 0.014 },
  { from: POSE.leftHip, to: POSE.rightHip, width: 0.019 },
  { from: POSE.leftHip, to: POSE.leftKnee, width: 0.02 },
  { from: POSE.leftKnee, to: POSE.leftAnkle, width: 0.016 },
  { from: POSE.rightHip, to: POSE.rightKnee, width: 0.02 },
  { from: POSE.rightKnee, to: POSE.rightAnkle, width: 0.016 }
];

export function drawPoseOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  analysis: AnalysisFrame | null,
  mirror: boolean,
  layers: AnatomyLayerState = defaultLayers
): void {
  const width = video.videoWidth || canvas.clientWidth;
  const height = video.videoHeight || canvas.clientHeight;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.clearRect(0, 0, width, height);

  if (!analysis) {
    drawFramingGuide(context, width, height);
    return;
  }

  const points = analysis.landmarks.map((landmark) => ({
    x: landmark.x * width,
    y: landmark.y * height,
    visibility: landmark.visibility ?? 0
  }));

  context.save();
  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }

  drawAnatomyBackdrop(context, width, height, layers);
  if (layers.body) {
    drawBodyLayer(context, analysis, points, width, height);
  }
  if (layers.muscles) {
    drawMuscleLayer(context, points, width, height);
  }
  if (layers.skeleton) {
    drawSkeletonLayer(context, analysis, points, width, height);
  }
  if (layers.gaussian) {
    drawGaussianRisks(context, analysis, width, height);
    drawWristTrail(context, analysis, points, width);
  }
  context.restore();

}

function drawFramingGuide(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.25)";
  context.lineWidth = 2;
  context.setLineDash([10, 12]);
  context.strokeRect(width * 0.18, height * 0.06, width * 0.64, height * 0.88);
  context.restore();
}

function drawAnatomyBackdrop(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  layers: AnatomyLayerState
): void {
  if (!layers.body && !layers.muscles && !layers.skeleton) {
    return;
  }

  context.save();
  context.fillStyle = "rgba(2, 6, 8, 0.08)";
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawBodyLayer(
  context: CanvasRenderingContext2D,
  analysis: AnalysisFrame,
  points: ScreenPoint[],
  width: number,
  height: number
): void {
  context.save();
  context.globalCompositeOperation = "source-over";

  const shoulderLeft = points[POSE.leftShoulder];
  const shoulderRight = points[POSE.rightShoulder];
  const hipLeft = points[POSE.leftHip];
  const hipRight = points[POSE.rightHip];

  if (visible(shoulderLeft, shoulderRight, hipLeft, hipRight)) {
    const torsoGradient = context.createLinearGradient(
      (shoulderLeft.x + shoulderRight.x) / 2,
      (shoulderLeft.y + shoulderRight.y) / 2,
      (hipLeft.x + hipRight.x) / 2,
      (hipLeft.y + hipRight.y) / 2
    );
    torsoGradient.addColorStop(0, "rgba(162, 196, 210, 0.35)");
    torsoGradient.addColorStop(1, "rgba(105, 136, 150, 0.22)");
    context.fillStyle = torsoGradient;
    context.strokeStyle = "rgba(232, 246, 250, 0.42)";
    context.lineWidth = Math.max(2, width * 0.004);
    context.beginPath();
    context.moveTo(shoulderLeft.x, shoulderLeft.y);
    context.quadraticCurveTo((shoulderLeft.x + hipLeft.x) / 2 - width * 0.025, (shoulderLeft.y + hipLeft.y) / 2, hipLeft.x, hipLeft.y);
    context.lineTo(hipRight.x, hipRight.y);
    context.quadraticCurveTo(
      (shoulderRight.x + hipRight.x) / 2 + width * 0.025,
      (shoulderRight.y + hipRight.y) / 2,
      shoulderRight.x,
      shoulderRight.y
    );
    context.closePath();
    context.fill();
    context.stroke();
  }

  for (const segment of bodySegments) {
    drawCapsule(context, points[segment.from], points[segment.to], width * segment.width, "rgba(166, 194, 205, 0.24)", "rgba(236, 248, 250, 0.22)");
  }

  drawHeadShell(context, points, width, height);
  context.restore();
}

function drawHeadShell(context: CanvasRenderingContext2D, points: ScreenPoint[], width: number, _height: number): void {
  const nose = points[POSE.nose];
  const leftEar = points[POSE.leftEar];
  const rightEar = points[POSE.rightEar];
  if (!visible(nose) || !visible(leftEar) || !visible(rightEar)) {
    return;
  }

  const centerX = (nose.x + leftEar.x + rightEar.x) / 3;
  const centerY = (nose.y + leftEar.y + rightEar.y) / 3;
  const radiusX = Math.max(18, Math.abs(leftEar.x - rightEar.x) * 0.62);
  const radiusY = Math.max(22, radiusX * 1.25);
  context.save();
  context.fillStyle = "rgba(166, 194, 205, 0.22)";
  context.strokeStyle = "rgba(236, 248, 250, 0.28)";
  context.lineWidth = Math.max(2, width * 0.003);
  context.beginPath();
  context.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawSkeletonLayer(
  context: CanvasRenderingContext2D,
  analysis: AnalysisFrame,
  points: ScreenPoint[],
  width: number,
  height: number
): void {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(255, 238, 205, 0.55)";
  context.shadowBlur = Math.max(6, width * 0.008);

  for (const segment of boneSegments) {
    drawBone(context, points[segment.from], points[segment.to], width * segment.width);
  }

  drawSpineAndRibs(context, points, width, height);
  drawJointCaps(context, analysis, points, width);
  context.restore();
}

function drawSpineAndRibs(context: CanvasRenderingContext2D, points: ScreenPoint[], width: number, height: number): void {
  const shoulderMid = midpoint(points[POSE.leftShoulder], points[POSE.rightShoulder]);
  const hipMid = midpoint(points[POSE.leftHip], points[POSE.rightHip]);
  if (!shoulderMid || !hipMid || !visible(shoulderMid, hipMid)) {
    return;
  }

  drawBone(context, shoulderMid, hipMid, width * 0.014);

  const ribWidth = distance(points[POSE.leftShoulder], points[POSE.rightShoulder]) * 0.74;
  const ribHeight = Math.max(height * 0.04, distance(shoulderMid, hipMid) * 0.33);
  context.save();
  context.strokeStyle = "rgba(255, 241, 216, 0.68)";
  context.lineWidth = Math.max(2, width * 0.004);
  context.beginPath();
  context.ellipse(shoulderMid.x, shoulderMid.y + ribHeight * 0.58, ribWidth * 0.5, ribHeight, 0, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.ellipse(hipMid.x, hipMid.y, ribWidth * 0.42, ribHeight * 0.42, 0, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawJointCaps(context: CanvasRenderingContext2D, analysis: AnalysisFrame, points: ScreenPoint[], width: number): void {
  for (const index of COACH_JOINTS) {
    const point = points[index];
    if (!visible(point) || point.visibility < 0.25) {
      continue;
    }

    const relatedRisk = analysis.jointRisks.find((risk) => risk.index === index);
    const radius = Math.max(6, width * 0.009) * (relatedRisk ? 1.25 : 1);
    context.beginPath();
    context.fillStyle = relatedRisk ? "rgba(255, 197, 132, 0.92)" : "rgba(255, 249, 239, 0.94)";
    context.strokeStyle = "rgba(67, 53, 35, 0.35)";
    context.lineWidth = Math.max(1.5, width * 0.002);
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
}

function drawMuscleLayer(
  context: CanvasRenderingContext2D,
  points: ScreenPoint[],
  width: number,
  height: number
): void {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.shadowBlur = Math.max(8, width * 0.011);

  // These values are fixed visual weights. They illustrate landmark regions and
  // must not be interpreted as measured muscle activation or tissue load.
  const posterior = 0.54;
  const knee = 0.42;
  const spine = 0.46;
  const shoulder = 0.38;
  const grip = 0.34;

  drawTorsoMuscles(context, points, width, spine, shoulder);
  drawGlute(context, points[POSE.leftHip], points[POSE.leftKnee], width, -1, posterior);
  drawGlute(context, points[POSE.rightHip], points[POSE.rightKnee], width, 1, posterior);
  drawMuscleBand(context, points[POSE.leftHip], points[POSE.leftKnee], width * 0.034, "rgba(255, 132, 83, OPACITY)", posterior, -width * 0.018, height * 0.012);
  drawMuscleBand(context, points[POSE.rightHip], points[POSE.rightKnee], width * 0.034, "rgba(255, 132, 83, OPACITY)", posterior, width * 0.018, height * 0.012);
  drawMuscleBand(context, points[POSE.leftHip], points[POSE.leftKnee], width * 0.032, "rgba(246, 198, 109, OPACITY)", knee, -width * 0.012, -height * 0.01);
  drawMuscleBand(context, points[POSE.rightHip], points[POSE.rightKnee], width * 0.032, "rgba(246, 198, 109, OPACITY)", knee, width * 0.012, -height * 0.01);
  drawMuscleBand(context, points[POSE.leftKnee], points[POSE.leftAnkle], width * 0.026, "rgba(116, 211, 166, OPACITY)", posterior, -width * 0.01, height * 0.008);
  drawMuscleBand(context, points[POSE.rightKnee], points[POSE.rightAnkle], width * 0.026, "rgba(116, 211, 166, OPACITY)", posterior, width * 0.01, height * 0.008);
  drawMuscleBand(context, points[POSE.leftShoulder], points[POSE.leftElbow], width * 0.026, "rgba(255, 154, 178, OPACITY)", shoulder, -width * 0.014, 0);
  drawMuscleBand(context, points[POSE.rightShoulder], points[POSE.rightElbow], width * 0.026, "rgba(255, 154, 178, OPACITY)", shoulder, width * 0.014, 0);
  drawMuscleBand(context, points[POSE.leftElbow], points[POSE.leftWrist], width * 0.02, "rgba(216, 178, 125, OPACITY)", grip, -width * 0.008, 0);
  drawMuscleBand(context, points[POSE.rightElbow], points[POSE.rightWrist], width * 0.02, "rgba(216, 178, 125, OPACITY)", grip, width * 0.008, 0);

  context.restore();
}

function drawTorsoMuscles(context: CanvasRenderingContext2D, points: ScreenPoint[], width: number, spine: number, shoulder: number): void {
  const shoulderMid = midpoint(points[POSE.leftShoulder], points[POSE.rightShoulder]);
  const hipMid = midpoint(points[POSE.leftHip], points[POSE.rightHip]);
  if (!shoulderMid || !hipMid || !visible(shoulderMid, hipMid)) {
    return;
  }

  drawMuscleBand(context, hipMid, shoulderMid, width * 0.026, "rgba(157, 124, 240, OPACITY)", spine, 0, 0);
  drawMuscleBand(context, points[POSE.leftShoulder], points[POSE.leftHip], width * 0.03, "rgba(123, 168, 255, OPACITY)", shoulder, -width * 0.028, 0);
  drawMuscleBand(context, points[POSE.rightShoulder], points[POSE.rightHip], width * 0.03, "rgba(123, 168, 255, OPACITY)", shoulder, width * 0.028, 0);
  drawMuscleBand(context, hipMid, shoulderMid, width * 0.033, "rgba(95, 198, 212, OPACITY)", spine * 0.72, 0, -width * 0.012);
}

function drawGlute(
  context: CanvasRenderingContext2D,
  hip: ScreenPoint,
  knee: ScreenPoint,
  width: number,
  side: -1 | 1,
  activation: number
): void {
  if (!visible(hip, knee)) {
    return;
  }
  const x = hip.x + side * width * 0.024;
  const y = hip.y + (knee.y - hip.y) * 0.13;
  const radiusX = width * 0.05;
  const radiusY = width * 0.036;
  context.save();
  context.shadowColor = `rgba(255, 107, 107, ${0.2 + activation * 0.36})`;
  context.fillStyle = `rgba(255, 107, 107, ${0.22 + activation * 0.36})`;
  context.strokeStyle = `rgba(255, 201, 181, ${0.22 + activation * 0.42})`;
  context.lineWidth = Math.max(2, width * 0.003);
  context.beginPath();
  context.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawMuscleBand(
  context: CanvasRenderingContext2D,
  start: ScreenPoint,
  end: ScreenPoint,
  lineWidth: number,
  colorTemplate: string,
  activation: number,
  offsetX: number,
  offsetY: number
): void {
  if (!visible(start, end)) {
    return;
  }

  const opacity = 0.18 + activation * 0.46;
  const color = colorTemplate.replace("OPACITY", opacity.toFixed(3));
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = colorTemplate.replace("OPACITY", (0.22 + activation * 0.5).toFixed(3));
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(start.x + offsetX, start.y + offsetY);
  context.lineTo(end.x + offsetX, end.y + offsetY);
  context.stroke();
  context.strokeStyle = "rgba(255, 255, 255, 0.18)";
  context.lineWidth = Math.max(1.5, lineWidth * 0.16);
  context.beginPath();
  context.moveTo(start.x + offsetX - lineWidth * 0.12, start.y + offsetY);
  context.lineTo(end.x + offsetX - lineWidth * 0.12, end.y + offsetY);
  context.stroke();
  context.restore();
}

function drawCapsule(
  context: CanvasRenderingContext2D,
  start: ScreenPoint,
  end: ScreenPoint,
  lineWidth: number,
  fill: string,
  stroke: string
): void {
  if (!visible(start, end)) {
    return;
  }
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = fill;
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.strokeStyle = stroke;
  context.lineWidth = Math.max(2, lineWidth * 0.08);
  context.stroke();
  context.restore();
}

function drawBone(context: CanvasRenderingContext2D, start: ScreenPoint, end: ScreenPoint, lineWidth: number): void {
  if (!visible(start, end)) {
    return;
  }

  context.save();
  context.strokeStyle = "rgba(255, 244, 223, 0.9)";
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.strokeStyle = "rgba(92, 75, 45, 0.28)";
  context.lineWidth = Math.max(1.5, lineWidth * 0.18);
  context.stroke();
  context.restore();
}

function drawGaussianRisks(context: CanvasRenderingContext2D, analysis: AnalysisFrame, width: number, height: number): void {
  context.save();
  context.globalCompositeOperation = "screen";

  for (const risk of analysis.jointRisks) {
    const x = risk.center.x * width;
    const y = risk.center.y * height;
    const radius = Math.max(width, height) * risk.radius;
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, risk.color);
    gradient.addColorStop(0.45, risk.color.replace(/[\d.]+\)$/u, `${0.22 * risk.intensity})`));
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.restore();
}

function drawWristTrail(
  context: CanvasRenderingContext2D,
  analysis: AnalysisFrame,
  points: ScreenPoint[],
  width: number
): void {
  const leftWrist = points[POSE.leftWrist];
  const rightWrist = points[POSE.rightWrist];
  if (!visible(leftWrist, rightWrist)) {
    return;
  }

  context.save();
  const wristX = (leftWrist.x + rightWrist.x) / 2;
  const wristY = (leftWrist.y + rightWrist.y) / 2;
  const radius = Math.max(20, width * 0.032);
  const gradient = context.createRadialGradient(wristX, wristY, 0, wristX, wristY, radius);
  gradient.addColorStop(0, "rgba(132, 220, 198, 0.72)");
  gradient.addColorStop(1, "rgba(132, 220, 198, 0)");
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(wristX, wristY, radius, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

function visible(...points: Array<ScreenPoint | undefined>): boolean {
  return points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.visibility > 0.22);
}

function midpoint(a: ScreenPoint | undefined, b: ScreenPoint | undefined): ScreenPoint | null {
  if (!a || !b) {
    return null;
  }
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: Math.min(a.visibility, b.visibility)
  };
}

function distance(a: ScreenPoint | undefined, b: ScreenPoint | undefined): number {
  if (!a || !b) {
    return 0;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
}
