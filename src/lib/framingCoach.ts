import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { POSE } from "./landmarks";

export type FramingCueId =
  | "finding"
  | "adjust-frame"
  | "move-left"
  | "move-right"
  | "step-back"
  | "move-closer"
  | "turn-side-on"
  | "ready";

export type FramingCue = {
  id: FramingCueId;
  label: string;
  detail: string;
  speech: string;
  tone: "neutral" | "adjust" | "ready";
};

type FramingOptions = {
  mirrored?: boolean;
  requireSideView?: boolean;
  aspectRatio?: number | null;
};

const MIN_VISIBILITY = 0.55;
const MIN_REQUIRED_VISIBILITY = 0.3;
const HORIZONTAL_SAFE_MIN = 0.37;
const HORIZONTAL_SAFE_MAX = 0.63;
const FRAME_EDGE_MARGIN = 0.045;
const MIN_BODY_HEIGHT = 0.55;
const MAX_BODY_HEIGHT = 0.8;
const DEFAULT_ASPECT_RATIO = 4 / 3;
const MAX_SIDE_ON_SHOULDER_RATIO = 0.27;

export const FRAMING_CUES: Record<FramingCueId, FramingCue> = {
  finding: {
    id: "finding",
    label: "Step into view",
    detail: "Let the coach see your head, hands, and feet.",
    speech: "Step into the camera view.",
    tone: "neutral"
  },
  "adjust-frame": {
    id: "adjust-frame",
    label: "Show your full body",
    detail: "Bring your head, hands, hips, knees, and feet into the full frame.",
    speech: "Bring your full body into view.",
    tone: "neutral"
  },
  "move-left": {
    id: "move-left",
    label: "Move left",
    detail: "Shift toward the left side of the preview.",
    speech: "Move a little left in the frame.",
    tone: "adjust"
  },
  "move-right": {
    id: "move-right",
    label: "Move right",
    detail: "Shift toward the right side of the preview.",
    speech: "Move a little right in the frame.",
    tone: "adjust"
  },
  "step-back": {
    id: "step-back",
    label: "Step back slightly",
    detail: "Keep your head, hands, feet, and bell inside the frame.",
    speech: "Step away from the camera. Keep your head, hands, and feet in view.",
    tone: "adjust"
  },
  "move-closer": {
    id: "move-closer",
    label: "Move a little closer",
    detail: "Fill more of the frame without clipping your hands or feet.",
    speech: "Move a little closer.",
    tone: "adjust"
  },
  "turn-side-on": {
    id: "turn-side-on",
    label: "Turn side-on",
    detail: "A clean side view makes the swing landmarks more reliable.",
    speech: "Turn side-on to the camera.",
    tone: "adjust"
  },
  ready: {
    id: "ready",
    label: "Position looks good",
    detail: "Stay here and leave clear space around the bell.",
    speech: "Great. You are in a good position.",
    tone: "ready"
  }
};

function visible(
  point: NormalizedLandmark | undefined,
  minimumVisibility = MIN_VISIBILITY
): point is NormalizedLandmark {
  return Boolean(
    point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      (point.visibility ?? 0) >= minimumVisibility
  );
}

function mostVisible(
  landmarks: NormalizedLandmark[],
  indices: readonly number[]
): NormalizedLandmark | null {
  let best: NormalizedLandmark | null = null;
  for (const index of indices) {
    const point = landmarks[index];
    if (visible(point) && (!best || (point.visibility ?? 0) > (best.visibility ?? 0))) {
      best = point;
    }
  }
  return best;
}

function displayX(x: number, mirrored: boolean): number {
  return mirrored ? 1 - x : x;
}

export function getFramingCue(
  landmarks: NormalizedLandmark[] | null | undefined,
  {
    mirrored = true,
    requireSideView = true,
    aspectRatio = DEFAULT_ASPECT_RATIO
  }: FramingOptions = {}
): FramingCue {
  if (!landmarks || landmarks.length < 33) {
    return FRAMING_CUES.finding;
  }

  const head = mostVisible(landmarks, [POSE.nose, POSE.leftEar, POSE.rightEar]);
  const leftShoulder = landmarks[POSE.leftShoulder];
  const rightShoulder = landmarks[POSE.rightShoulder];
  const shoulder = mostVisible(landmarks, [POSE.leftShoulder, POSE.rightShoulder]);
  const hip = mostVisible(landmarks, [POSE.leftHip, POSE.rightHip]);
  const requiredCore = [
    leftShoulder,
    rightShoulder,
    landmarks[POSE.leftHip],
    landmarks[POSE.rightHip],
    landmarks[POSE.leftKnee],
    landmarks[POSE.rightKnee]
  ];
  const leftWrist = visible(landmarks[POSE.leftWrist], MIN_REQUIRED_VISIBILITY)
    ? landmarks[POSE.leftWrist]
    : null;
  const rightWrist = visible(landmarks[POSE.rightWrist], MIN_REQUIRED_VISIBILITY)
    ? landmarks[POSE.rightWrist]
    : null;
  const leftAnkle = visible(landmarks[POSE.leftAnkle], MIN_REQUIRED_VISIBILITY)
    ? landmarks[POSE.leftAnkle]
    : null;
  const rightAnkle = visible(landmarks[POSE.rightAnkle], MIN_REQUIRED_VISIBILITY)
    ? landmarks[POSE.rightAnkle]
    : null;
  const leftToe = visible(landmarks[POSE.leftFootIndex], MIN_REQUIRED_VISIBILITY)
    ? landmarks[POSE.leftFootIndex]
    : null;
  const rightToe = visible(landmarks[POSE.rightFootIndex], MIN_REQUIRED_VISIBILITY)
    ? landmarks[POSE.rightFootIndex]
    : null;

  if (!shoulder || !hip) {
    return FRAMING_CUES.finding;
  }

  const centerPoints = [
    landmarks[POSE.leftShoulder],
    landmarks[POSE.rightShoulder],
    landmarks[POSE.leftHip],
    landmarks[POSE.rightHip]
  ].filter((point): point is NormalizedLandmark => visible(point));
  const centerX = centerPoints.reduce((sum, point) => sum + displayX(point.x, mirrored), 0) /
    centerPoints.length;

  if (
    !head ||
    !requiredCore.every((point) => visible(point, MIN_REQUIRED_VISIBILITY)) ||
    !leftWrist ||
    !rightWrist ||
    !leftAnkle ||
    !rightAnkle ||
    !leftToe ||
    !rightToe
  ) {
    return FRAMING_CUES["adjust-frame"];
  }

  const lowestFootY = Math.max(leftAnkle.y, rightAnkle.y, leftToe.y, rightToe.y);
  const bodyHeight = lowestFootY - head.y;
  const wrists = [leftWrist, rightWrist];
  const feet = [leftAnkle, rightAnkle, leftToe, rightToe];
  const envelope = [
    head,
    ...requiredCore,
    ...wrists,
    ...feet
  ].filter((point): point is NormalizedLandmark =>
    visible(point, MIN_REQUIRED_VISIBILITY)
  );
  const touchesEdge = envelope.some((point) => {
    const x = displayX(point.x, mirrored);
    return (
      x <= FRAME_EDGE_MARGIN ||
      x >= 1 - FRAME_EDGE_MARGIN ||
      point.y <= FRAME_EDGE_MARGIN ||
      point.y >= 1 - FRAME_EDGE_MARGIN
    );
  });

  if (!Number.isFinite(bodyHeight) || bodyHeight > MAX_BODY_HEIGHT || touchesEdge) {
    return FRAMING_CUES["step-back"];
  }
  if (centerX < HORIZONTAL_SAFE_MIN) {
    return FRAMING_CUES["move-right"];
  }
  if (centerX > HORIZONTAL_SAFE_MAX) {
    return FRAMING_CUES["move-left"];
  }
  if (bodyHeight < MIN_BODY_HEIGHT) {
    return FRAMING_CUES["move-closer"];
  }

  if (requireSideView) {
    if (
      !visible(leftShoulder, MIN_REQUIRED_VISIBILITY) ||
      !visible(rightShoulder, MIN_REQUIRED_VISIBILITY)
    ) {
      return FRAMING_CUES["turn-side-on"];
    }
    const safeAspectRatio =
      Number.isFinite(aspectRatio) && aspectRatio! > 0.25 && aspectRatio! < 4
        ? aspectRatio!
        : DEFAULT_ASPECT_RATIO;
    const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
    if ((shoulderWidth * safeAspectRatio) / bodyHeight > MAX_SIDE_ON_SHOULDER_RATIO) {
      return FRAMING_CUES["turn-side-on"];
    }
  }

  return FRAMING_CUES.ready;
}
