# Coach Model

## Target Movement

This implementation targets a two-hand hardstyle/Russian kettlebell swing: hip-dominant hinge, neutral torso/head stack, relaxed arms, and a bell path driven by hip extension. Other swing styles can be valid, but they are not the scoring target.

## Live Inputs

- `landmarks`: normalized 2D MediaPipe landmarks for camera overlay, framing, bell/hand height, and side-view quality.
- `worldLandmarks`: MediaPipe meter-scale 3D landmarks for hip angle, knee angle, torso length, shoulder width, and wrist depth travel.
- `settings`: height, bell weight, experience level, goal, and whether side-view enforcement is enabled.
- `calibration`: standing tall sample used to personalize upright hip angle, knee angle, torso lean, body proportions, visibility, and jitter.

## Scored Metrics

- `hipFlexionDelta`: calibrated upright hip angle minus current hip angle.
- `kneeFlexionDelta`: calibrated upright knee angle minus current knee angle.
- `hingeRatio`: hip flexion delta divided by knee flexion delta. Low values indicate a squat-dominant rep.
- `wristHeight`: hand midpoint height relative to body height.
- `shoulderLift`: hand midpoint above shoulder level. High values indicate arm pull.
- `spineStack`: proxy score from torso/head alignment and top-position overlean.
- `depthTravel`: recent wrist world-z travel normalized by calibrated torso length and user height.
- `cameraQuality`: side-view and full-body-framing score.
- `visibility`: landmark confidence over shoulders, hips, knees, and ankles.

## Phase Model

The analyzer runs a small finite-state model:

- `backswing`: hip flexion delta exceeds the bottom threshold and is not rapidly decreasing.
- `drive`: hip flexion delta is decreasing quickly after a loaded backswing.
- `float`: hips are near lockout and hands are above the hip line.
- `lockout`: hips are near calibrated upright with hands below high-float range.
- `waiting`: insufficient pose confidence or no active swing phase.

A rep is counted after a loaded backswing returns to the top threshold with the hands above the hip line and a cooldown has elapsed.

## Feedback Rules

- Camera: asks for full-body side view when visibility or shoulder-width/body-height quality is low.
- Hinge: flags squat-dominant backswing when hinge ratio falls below the goal/experience threshold.
- Depth: flags shallow backswing when recent hip depth or wrist depth travel is too small.
- Lockout: flags incomplete hip extension when the top phase remains folded.
- Shoulders: flags arm lift when wrists rise above shoulder height.
- Spine: flags neck/torso stack issues and top-position overlean.

## 3D Anatomy Layers

The app renders four independently toggled coaching layers in both the live camera projection and the Three.js scene:

- `Body`: translucent procedural body volumes anchored to shoulders, hips, elbows, wrists, knees, ankles, ears, and nose.
- `Muscle`: simplified muscle volumes for the swing-relevant chain: glutes, hamstrings, quads, calves, spinal erectors, anterior core, lats, deltoids, and forearm flexors.
- `Bone`: ivory skeletal capsules and joint spheres driven by the same world landmarks as the scoring engine.
- `Field`: Gaussian confidence and correction fields around coached joints.

Muscle opacity and emissive intensity are metric-driven, not EMG-derived. Posterior-chain muscles brighten with hinge ratio, depth travel, and rep velocity; quads brighten when knee flexion dominates; lats and deltoids brighten when hand height or shoulder-lift risk rises; spinal/core volumes brighten when stack demand rises.

## Current Limits

- The app estimates the kettlebell from wrist midpoint because the bell is not separately detected.
- Monocular world landmarks are useful but not equivalent to calibrated multi-camera motion capture.
- Dense depth is not yet fused; depth travel currently comes from MediaPipe world landmarks.
- Anatomy layers are procedural coaching visualizations, not diagnostic anatomical segmentation.
- Medical, pain, and rehab decisions need a qualified human coach or clinician.

## Research Sources

- MediaPipe Pose Landmarker Web docs: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js
- BlazePose GHUM paper: https://arxiv.org/abs/2206.11678
- Depth Anything V2 repository: https://github.com/DepthAnything/Depth-Anything-V2
- Kettlebell swing styles differ biomechanically: https://pubmed.ncbi.nlm.nih.gov/28593086/
- Hip-hinge swing hamstring EMG comparison: https://pubmed.ncbi.nlm.nih.gov/28930870/
