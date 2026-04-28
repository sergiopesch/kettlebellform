import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AnalysisFrame, AnatomyLayerState } from "../types";
import { COACH_JOINTS, POSE, SKELETON_CONNECTIONS } from "../lib/landmarks";

type PoseSceneProps = {
  analysis: AnalysisFrame | null;
  layers: AnatomyLayerState;
};

type Anchor = number | "shoulderMid" | "hipMid" | "headMid" | "leftHand" | "rightHand";

type BodySegmentSpec = {
  id: string;
  from: Anchor;
  to: Anchor;
  radiusX: number;
  radiusZ: number;
};

type MuscleMetric = "posterior" | "knee" | "spine" | "shoulder" | "grip";

type MuscleSpec = {
  id: string;
  label: string;
  from: Anchor;
  to: Anchor;
  color: number;
  metric: MuscleMetric;
  radiusX: number;
  radiusZ: number;
  startT?: number;
  endT?: number;
  sideOffset?: number;
  depthOffset?: number;
};

type SceneRefs = {
  skeletonGroup: THREE.Group;
  bodyGroup: THREE.Group;
  muscleGroup: THREE.Group;
  gaussianGroup: THREE.Group;
  boneMeshes: THREE.Mesh[];
  jointMeshes: THREE.Mesh[];
  bodyMeshes: THREE.Mesh[];
  muscleMeshes: THREE.Mesh[];
  gaussianMeshes: THREE.Mesh[];
  trail: THREE.Line;
  trailPositions: Float32Array;
};

const SCALE = 2.8;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const BODY_SEGMENTS: BodySegmentSpec[] = [
  { id: "torso", from: "hipMid", to: "shoulderMid", radiusX: 0.27, radiusZ: 0.15 },
  { id: "pelvis", from: POSE.leftHip, to: POSE.rightHip, radiusX: 0.17, radiusZ: 0.19 },
  { id: "leftUpperArm", from: POSE.leftShoulder, to: POSE.leftElbow, radiusX: 0.07, radiusZ: 0.06 },
  { id: "leftForearm", from: POSE.leftElbow, to: "leftHand", radiusX: 0.055, radiusZ: 0.047 },
  { id: "rightUpperArm", from: POSE.rightShoulder, to: POSE.rightElbow, radiusX: 0.07, radiusZ: 0.06 },
  { id: "rightForearm", from: POSE.rightElbow, to: "rightHand", radiusX: 0.055, radiusZ: 0.047 },
  { id: "leftThigh", from: POSE.leftHip, to: POSE.leftKnee, radiusX: 0.105, radiusZ: 0.09 },
  { id: "leftShin", from: POSE.leftKnee, to: POSE.leftAnkle, radiusX: 0.078, radiusZ: 0.064 },
  { id: "rightThigh", from: POSE.rightHip, to: POSE.rightKnee, radiusX: 0.105, radiusZ: 0.09 },
  { id: "rightShin", from: POSE.rightKnee, to: POSE.rightAnkle, radiusX: 0.078, radiusZ: 0.064 }
];

const MUSCLES: MuscleSpec[] = [
  {
    id: "erectors",
    label: "Spinal erectors",
    from: "hipMid",
    to: "shoulderMid",
    color: 0x9d7cf0,
    metric: "spine",
    radiusX: 0.062,
    radiusZ: 0.052,
    startT: 0.08,
    endT: 0.92,
    depthOffset: -0.075
  },
  {
    id: "core",
    label: "Anterior core",
    from: "hipMid",
    to: "shoulderMid",
    color: 0x5fc6d4,
    metric: "spine",
    radiusX: 0.082,
    radiusZ: 0.048,
    startT: 0.1,
    endT: 0.86,
    depthOffset: 0.08
  },
  {
    id: "leftGlute",
    label: "Left glute",
    from: POSE.leftHip,
    to: POSE.leftKnee,
    color: 0xff6b6b,
    metric: "posterior",
    radiusX: 0.13,
    radiusZ: 0.09,
    startT: 0,
    endT: 0.34,
    sideOffset: -0.035,
    depthOffset: -0.08
  },
  {
    id: "rightGlute",
    label: "Right glute",
    from: POSE.rightHip,
    to: POSE.rightKnee,
    color: 0xff6b6b,
    metric: "posterior",
    radiusX: 0.13,
    radiusZ: 0.09,
    startT: 0,
    endT: 0.34,
    sideOffset: 0.035,
    depthOffset: -0.08
  },
  {
    id: "leftHamstring",
    label: "Left hamstring",
    from: POSE.leftHip,
    to: POSE.leftKnee,
    color: 0xff8d5c,
    metric: "posterior",
    radiusX: 0.082,
    radiusZ: 0.064,
    startT: 0.18,
    endT: 0.94,
    sideOffset: -0.025,
    depthOffset: -0.08
  },
  {
    id: "rightHamstring",
    label: "Right hamstring",
    from: POSE.rightHip,
    to: POSE.rightKnee,
    color: 0xff8d5c,
    metric: "posterior",
    radiusX: 0.082,
    radiusZ: 0.064,
    startT: 0.18,
    endT: 0.94,
    sideOffset: 0.025,
    depthOffset: -0.08
  },
  {
    id: "leftQuad",
    label: "Left quad",
    from: POSE.leftHip,
    to: POSE.leftKnee,
    color: 0xf2c66d,
    metric: "knee",
    radiusX: 0.082,
    radiusZ: 0.063,
    startT: 0.12,
    endT: 0.9,
    sideOffset: -0.02,
    depthOffset: 0.075
  },
  {
    id: "rightQuad",
    label: "Right quad",
    from: POSE.rightHip,
    to: POSE.rightKnee,
    color: 0xf2c66d,
    metric: "knee",
    radiusX: 0.082,
    radiusZ: 0.063,
    startT: 0.12,
    endT: 0.9,
    sideOffset: 0.02,
    depthOffset: 0.075
  },
  {
    id: "leftCalf",
    label: "Left calf",
    from: POSE.leftKnee,
    to: POSE.leftAnkle,
    color: 0x74d3a6,
    metric: "posterior",
    radiusX: 0.065,
    radiusZ: 0.055,
    startT: 0.2,
    endT: 0.88,
    sideOffset: -0.02,
    depthOffset: -0.055
  },
  {
    id: "rightCalf",
    label: "Right calf",
    from: POSE.rightKnee,
    to: POSE.rightAnkle,
    color: 0x74d3a6,
    metric: "posterior",
    radiusX: 0.065,
    radiusZ: 0.055,
    startT: 0.2,
    endT: 0.88,
    sideOffset: 0.02,
    depthOffset: -0.055
  },
  {
    id: "leftLat",
    label: "Left lat",
    from: POSE.leftShoulder,
    to: POSE.leftHip,
    color: 0x7ba8ff,
    metric: "shoulder",
    radiusX: 0.072,
    radiusZ: 0.052,
    startT: 0.12,
    endT: 0.82,
    sideOffset: -0.055,
    depthOffset: -0.035
  },
  {
    id: "rightLat",
    label: "Right lat",
    from: POSE.rightShoulder,
    to: POSE.rightHip,
    color: 0x7ba8ff,
    metric: "shoulder",
    radiusX: 0.072,
    radiusZ: 0.052,
    startT: 0.12,
    endT: 0.82,
    sideOffset: 0.055,
    depthOffset: -0.035
  },
  {
    id: "leftDeltoid",
    label: "Left deltoid",
    from: POSE.leftShoulder,
    to: POSE.leftElbow,
    color: 0xff9fb3,
    metric: "shoulder",
    radiusX: 0.069,
    radiusZ: 0.056,
    startT: 0,
    endT: 0.38,
    sideOffset: -0.045
  },
  {
    id: "rightDeltoid",
    label: "Right deltoid",
    from: POSE.rightShoulder,
    to: POSE.rightElbow,
    color: 0xff9fb3,
    metric: "shoulder",
    radiusX: 0.069,
    radiusZ: 0.056,
    startT: 0,
    endT: 0.38,
    sideOffset: 0.045
  },
  {
    id: "leftForearmFlexor",
    label: "Left forearm",
    from: POSE.leftElbow,
    to: "leftHand",
    color: 0xd8b27d,
    metric: "grip",
    radiusX: 0.052,
    radiusZ: 0.042,
    startT: 0.18,
    endT: 0.88,
    sideOffset: -0.018
  },
  {
    id: "rightForearmFlexor",
    label: "Right forearm",
    from: POSE.rightElbow,
    to: "rightHand",
    color: 0xd8b27d,
    metric: "grip",
    radiusX: 0.052,
    radiusZ: 0.042,
    startT: 0.18,
    endT: 0.88,
    sideOffset: 0.018
  }
];

export function PoseScene({ analysis, layers }: PoseSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const analysisRef = useRef<AnalysisFrame | null>(analysis);
  const layersRef = useRef<AnatomyLayerState>(layers);

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0d10);

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(1, host.clientHeight), 0.01, 100);
    camera.position.set(0, 1.1, 5.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 2.6;
    controls.maxDistance = 8;
    controls.target.set(0, 0.15, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 1.1);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xc9ddff, 1.7);
    key.position.set(2, 4, 3);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x84dcc6, 1.15);
    rim.position.set(-3, 1.5, -2.5);
    scene.add(rim);

    const plane = new THREE.GridHelper(4.2, 14, 0x2a353c, 0x172027);
    plane.position.y = -1.45;
    scene.add(plane);

    const skeletonGroup = new THREE.Group();
    const bodyGroup = new THREE.Group();
    const muscleGroup = new THREE.Group();
    const gaussianGroup = new THREE.Group();
    scene.add(bodyGroup, muscleGroup, skeletonGroup, gaussianGroup);

    const materials: THREE.Material[] = [];
    const geometries: THREE.BufferGeometry[] = [];

    const boneGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
    const jointGeometry = new THREE.SphereGeometry(0.038, 18, 18);
    const bodyGeometry = new THREE.SphereGeometry(1, 28, 18);
    const muscleGeometry = new THREE.SphereGeometry(1, 30, 18);
    const gaussianGeometry = new THREE.SphereGeometry(0.12, 24, 24);
    geometries.push(boneGeometry, jointGeometry, bodyGeometry, muscleGeometry, gaussianGeometry);

    const boneMaterial = new THREE.MeshStandardMaterial({
      color: 0xf2ead8,
      emissive: 0x211b12,
      roughness: 0.42,
      metalness: 0.06
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x27323a,
      roughness: 0.46,
      metalness: 0.08
    });
    const bodyMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x9fb7c5,
      transparent: true,
      opacity: 0.2,
      roughness: 0.32,
      metalness: 0,
      transmission: 0.06,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    materials.push(boneMaterial, jointMaterial, bodyMaterial);

    const boneMeshes = SKELETON_CONNECTIONS.map(() => {
      const mesh = new THREE.Mesh(boneGeometry, boneMaterial);
      mesh.visible = false;
      skeletonGroup.add(mesh);
      return mesh;
    });

    const jointMeshes = Array.from({ length: 33 }, () => {
      const mesh = new THREE.Mesh(jointGeometry, jointMaterial);
      mesh.visible = false;
      skeletonGroup.add(mesh);
      return mesh;
    });

    const bodyMeshes = BODY_SEGMENTS.map(() => {
      const mesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
      mesh.visible = false;
      bodyGroup.add(mesh);
      return mesh;
    });

    const headMesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
    headMesh.visible = false;
    bodyGroup.add(headMesh);
    bodyMeshes.push(headMesh);

    const muscleMeshes = MUSCLES.map((spec) => {
      const material = new THREE.MeshStandardMaterial({
        color: spec.color,
        emissive: spec.color,
        emissiveIntensity: 0.2,
        transparent: true,
        opacity: 0.38,
        roughness: 0.5,
        metalness: 0.04,
        depthWrite: false
      });
      materials.push(material);
      const mesh = new THREE.Mesh(muscleGeometry, material);
      mesh.visible = false;
      muscleGroup.add(mesh);
      return mesh;
    });

    const gaussianMeshes = COACH_JOINTS.map(() => {
      const material = new THREE.MeshBasicMaterial({
        color: 0x4f9fe3,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      materials.push(material);
      const mesh = new THREE.Mesh(gaussianGeometry, material);
      mesh.visible = false;
      gaussianGroup.add(mesh);
      return mesh;
    });

    const trailGeometry = new THREE.BufferGeometry();
    const trailPositions = new Float32Array(90 * 3);
    trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
    const trailMaterial = new THREE.LineBasicMaterial({ color: 0x84dcc6, transparent: true, opacity: 0.82 });
    const trail = new THREE.Line(trailGeometry, trailMaterial);
    materials.push(trailMaterial);
    geometries.push(trailGeometry);
    scene.add(trail);

    const refs: SceneRefs = {
      skeletonGroup,
      bodyGroup,
      muscleGroup,
      gaussianGroup,
      boneMeshes,
      jointMeshes,
      bodyMeshes,
      muscleMeshes,
      gaussianMeshes,
      trail,
      trailPositions
    };

    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(host);

    let isDisposed = false;
    const render = () => {
      if (isDisposed) {
        return;
      }

      updateScene(analysisRef.current, layersRef.current, refs);
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(render);
    };
    render();

    return () => {
      isDisposed = true;
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div className="pose-scene" ref={hostRef} />;
}

function updateScene(analysis: AnalysisFrame | null, layers: AnatomyLayerState, refs: SceneRefs): void {
  refs.skeletonGroup.visible = layers.skeleton;
  refs.bodyGroup.visible = layers.body;
  refs.muscleGroup.visible = layers.muscles;
  refs.gaussianGroup.visible = layers.gaussian;

  if (!analysis || analysis.worldLandmarks.length === 0) {
    hideMeshes(refs.boneMeshes);
    hideMeshes(refs.jointMeshes);
    hideMeshes(refs.bodyMeshes);
    hideMeshes(refs.muscleMeshes);
    hideMeshes(refs.gaussianMeshes);
    refs.trail.visible = false;
    return;
  }

  const anchors = createAnchors(analysis);

  updateSkeleton(analysis, anchors, refs);
  updateBody(analysis, anchors, refs);
  updateMuscles(analysis, anchors, refs);
  updateGaussianFields(analysis, refs);
  updateTrail(analysis, refs);
}

function updateSkeleton(analysis: AnalysisFrame, anchors: Map<Anchor, THREE.Vector3>, refs: SceneRefs): void {
  SKELETON_CONNECTIONS.forEach(([from, to], index) => {
    const start = anchors.get(from);
    const end = anchors.get(to);
    const visibility = Math.min(analysis.worldLandmarks[from]?.visibility ?? 0, analysis.worldLandmarks[to]?.visibility ?? 0);
    updateCapsule(refs.boneMeshes[index], start, end, 0.027, visibility > 0.25);
  });

  analysis.worldLandmarks.forEach((landmark, index) => {
    const mesh = refs.jointMeshes[index];
    if (!mesh) {
      return;
    }
    mesh.visible = landmark.visibility > 0.25;
    mesh.position.copy(toThree(landmark));
    const scale = 1.05 + (1 - Math.min(1, landmark.visibility)) * 1.35;
    mesh.scale.setScalar(scale);
  });
}

function updateBody(analysis: AnalysisFrame, anchors: Map<Anchor, THREE.Vector3>, refs: SceneRefs): void {
  BODY_SEGMENTS.forEach((spec, index) => {
    const start = anchors.get(spec.from);
    const end = anchors.get(spec.to);
    const visibility = anchorVisibility(analysis, spec.from, spec.to);
    updateEllipsoidSegment(refs.bodyMeshes[index], start, end, spec.radiusX, spec.radiusZ, visibility > 0.3);
  });

  const head = refs.bodyMeshes[BODY_SEGMENTS.length];
  const headCenter = anchors.get("headMid");
  if (!headCenter) {
    head.visible = false;
    return;
  }
  head.visible = anchorVisibility(analysis, POSE.leftEar, POSE.rightEar) > 0.22;
  head.position.copy(headCenter);
  head.quaternion.identity();
  head.scale.set(0.14, 0.18, 0.13);
}

function updateMuscles(analysis: AnalysisFrame, anchors: Map<Anchor, THREE.Vector3>, refs: SceneRefs): void {
  MUSCLES.forEach((spec, index) => {
    const from = anchors.get(spec.from);
    const to = anchors.get(spec.to);
    const mesh = refs.muscleMeshes[index];
    if (!from || !to || anchorVisibility(analysis, spec.from, spec.to) < 0.28) {
      mesh.visible = false;
      return;
    }

    const startT = spec.startT ?? 0;
    const endT = spec.endT ?? 1;
    const start = from.clone().lerp(to, startT);
    const end = from.clone().lerp(to, endT);
    const offset = new THREE.Vector3(spec.sideOffset ?? 0, 0, spec.depthOffset ?? 0);
    start.add(offset);
    end.add(offset);
    updateEllipsoidSegment(mesh, start, end, spec.radiusX, spec.radiusZ, true);

    const activation = muscleActivation(spec.metric, analysis);
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.opacity = 0.28 + activation * 0.44;
    material.emissiveIntensity = 0.18 + activation * 0.36;
  });
}

function updateGaussianFields(analysis: AnalysisFrame, refs: SceneRefs): void {
  COACH_JOINTS.forEach((jointIndex, meshIndex) => {
    const landmark = analysis.worldLandmarks[jointIndex];
    const mesh = refs.gaussianMeshes[meshIndex];
    const relatedRisk = analysis.jointRisks.find((risk) => risk.index === jointIndex);
    mesh.visible = Boolean(landmark && landmark.visibility > 0.2);
    mesh.position.copy(toThree(landmark));
    const uncertainty = 1 - Math.min(1, landmark.visibility);
    const riskScale = relatedRisk ? 1 + relatedRisk.intensity * 1.8 : 1;
    mesh.scale.setScalar((0.8 + uncertainty * 2.8) * riskScale);
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.opacity = relatedRisk ? 0.16 + relatedRisk.intensity * 0.18 : 0.055 + uncertainty * 0.09;
    material.color.set(relatedRisk?.color.includes("255, 92") ? 0xff6b6b : relatedRisk ? 0xffba63 : 0x4f9fe3);
  });
}

function updateTrail(analysis: AnalysisFrame, refs: SceneRefs): void {
  refs.trail.visible = analysis.wristTrail.length > 2;
  refs.trailPositions.fill(0);
  analysis.wristTrail.slice(-90).forEach((point, index) => {
    const threePoint = toThree(point);
    const trailOffset = index * 3;
    refs.trailPositions[trailOffset] = threePoint.x;
    refs.trailPositions[trailOffset + 1] = threePoint.y;
    refs.trailPositions[trailOffset + 2] = threePoint.z;
  });
  (refs.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  refs.trail.geometry.setDrawRange(0, analysis.wristTrail.length);
}

function createAnchors(analysis: AnalysisFrame): Map<Anchor, THREE.Vector3> {
  const anchors = new Map<Anchor, THREE.Vector3>();
  analysis.worldLandmarks.forEach((landmark, index) => {
    anchors.set(index, toThree(landmark));
  });

  const leftShoulder = anchors.get(POSE.leftShoulder);
  const rightShoulder = anchors.get(POSE.rightShoulder);
  const leftHip = anchors.get(POSE.leftHip);
  const rightHip = anchors.get(POSE.rightHip);
  const leftEar = anchors.get(POSE.leftEar);
  const rightEar = anchors.get(POSE.rightEar);
  const nose = anchors.get(POSE.nose);
  const leftWrist = anchors.get(POSE.leftWrist);
  const rightWrist = anchors.get(POSE.rightWrist);

  if (leftShoulder && rightShoulder) {
    anchors.set("shoulderMid", midpoint(leftShoulder, rightShoulder));
  }
  if (leftHip && rightHip) {
    anchors.set("hipMid", midpoint(leftHip, rightHip));
  }
  if (leftEar && rightEar && nose) {
    anchors.set("headMid", midpoint(midpoint(leftEar, rightEar), nose).add(new THREE.Vector3(0, 0.06, 0)));
  }
  if (leftWrist) {
    anchors.set("leftHand", leftWrist.clone().add(new THREE.Vector3(0, -0.03, 0)));
  }
  if (rightWrist) {
    anchors.set("rightHand", rightWrist.clone().add(new THREE.Vector3(0, -0.03, 0)));
  }

  return anchors;
}

function anchorVisibility(analysis: AnalysisFrame, from: Anchor, to: Anchor): number {
  return (visibilityForAnchor(analysis, from) + visibilityForAnchor(analysis, to)) / 2;
}

function visibilityForAnchor(analysis: AnalysisFrame, anchor: Anchor): number {
  if (typeof anchor === "number") {
    return analysis.worldLandmarks[anchor]?.visibility ?? 0;
  }

  if (anchor === "shoulderMid") {
    return anchorVisibility(analysis, POSE.leftShoulder, POSE.rightShoulder);
  }
  if (anchor === "hipMid") {
    return anchorVisibility(analysis, POSE.leftHip, POSE.rightHip);
  }
  if (anchor === "headMid") {
    return Math.max(analysis.worldLandmarks[POSE.nose]?.visibility ?? 0, anchorVisibility(analysis, POSE.leftEar, POSE.rightEar));
  }
  if (anchor === "leftHand") {
    return analysis.worldLandmarks[POSE.leftWrist]?.visibility ?? 0;
  }
  if (anchor === "rightHand") {
    return analysis.worldLandmarks[POSE.rightWrist]?.visibility ?? 0;
  }
  return 0;
}

function updateCapsule(
  mesh: THREE.Mesh,
  start: THREE.Vector3 | undefined,
  end: THREE.Vector3 | undefined,
  radius: number,
  visible: boolean
): void {
  if (!start || !end || !visible) {
    mesh.visible = false;
    return;
  }

  const length = start.distanceTo(end);
  if (length < 0.01) {
    mesh.visible = false;
    return;
  }

  const direction = end.clone().sub(start).normalize();
  mesh.visible = true;
  mesh.position.copy(midpoint(start, end));
  mesh.quaternion.setFromUnitVectors(Y_AXIS, direction);
  mesh.scale.set(radius, length, radius);
}

function updateEllipsoidSegment(
  mesh: THREE.Mesh,
  start: THREE.Vector3 | undefined,
  end: THREE.Vector3 | undefined,
  radiusX: number,
  radiusZ: number,
  visible: boolean
): void {
  if (!start || !end || !visible) {
    mesh.visible = false;
    return;
  }

  const length = start.distanceTo(end);
  if (length < 0.01) {
    mesh.visible = false;
    return;
  }

  const direction = end.clone().sub(start).normalize();
  mesh.visible = true;
  mesh.position.copy(midpoint(start, end));
  mesh.quaternion.setFromUnitVectors(Y_AXIS, direction);
  mesh.scale.set(radiusX, length * 0.52, radiusZ);
}

function muscleActivation(metric: MuscleMetric, analysis: AnalysisFrame): number {
  const metrics = analysis.metrics;

  if (metric === "posterior") {
    return THREE.MathUtils.clamp(metrics.hingeRatio / 1.85 + metrics.depthTravel * 0.25 + metrics.repVelocity / 190, 0.18, 1);
  }
  if (metric === "knee") {
    return THREE.MathUtils.clamp(metrics.kneeFlexionDelta / 54 + (1 - Math.min(metrics.hingeRatio / 1.7, 1)) * 0.32, 0.14, 0.92);
  }
  if (metric === "spine") {
    return THREE.MathUtils.clamp((1 - metrics.spineStack) * 0.7 + metrics.hipFlexionDelta / 110 + 0.18, 0.18, 1);
  }
  if (metric === "shoulder") {
    return THREE.MathUtils.clamp(metrics.shoulderLift / 0.15 + metrics.wristHeight * 0.22 + 0.14, 0.14, 1);
  }
  return THREE.MathUtils.clamp(metrics.wristHeight * 0.5 + metrics.repVelocity / 220 + 0.18, 0.16, 0.95);
}

function hideMeshes(meshes: THREE.Mesh[]): void {
  meshes.forEach((mesh) => {
    mesh.visible = false;
  });
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function toThree(point: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(point.x * SCALE, -point.y * SCALE + 0.1, -point.z * SCALE);
}
