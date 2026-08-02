# Coach Model

This document describes the current analyzer contract. Product claims, safety language, validation requirements, and source evidence are defined in [Evidence and Safety Specification](./EVIDENCE_AND_SAFETY.md); that document takes precedence if wording here could be read as a health or safety claim.

## Supported movement

The first assessment mode is deliberately narrow:

> **One person performing a two-hand, shoulder-height, hip-hinge kettlebell swing from a side view.**

The model observes a hip-dominant backswing, an extension-driven ascent, hands reaching the selected shoulder-height range, and a gross tall finish relative to the user's upright reference.

Overhead, squat-style, double-knee-extension, one-hand, hand-to-hand, sport, and other swing variations may be valid movements, but they are outside this mode. The app must report an unsupported style or abstain; it must not label another style as a fault or safety problem.

## Inputs and measurement boundary

The analyzer receives:

- Normalized image landmarks for visibility, side-view/framing heuristics, torso orientation, and wrist height.
- Pose-model coordinates for bilateral hip and knee angles and gross head-to-torso orientation.
- User settings for bell mass, experience, coaching focus, and side-view enforcement.
- An optional standing reference used to personalize upright hip angle, knee angle, and gross torso lean.

Pose-model coordinates are estimates, not motion-capture ground truth. They are not used to claim measured physical distance, bell velocity, force, torque, spinal load, or tissue demand. Entered height and bell mass provide session context and may adjust heuristics; they do not allow the camera to determine whether a load is appropriate.

The kettlebell is not separately detected. Wrist midpoint is a proxy for hand/bell height, so any bell-path wording must remain approximate and be suppressed when the hands are occluded.

## Calibration gates

Calibration is optional but recommended. Without a saved reference, the analyzer uses conservative default angles and the UI says so. A reference belongs only to the continuously verified subject in the current camera session. A short pause may retain it only when geometric continuity is reacquired; ambiguity, identity discontinuity, camera switching, demo mode, model failure, or session end discards it.

The live capture waits for at least **48 frames** spanning at least **2,000 ms** before attempting to save a reference. The profile validator then fails closed unless all of the following hold:

- At least 30 qualifying samples span at least 1,500 ms.
- At least 80% of submitted samples qualify.
- Shoulder, hip, knee, and ankle landmarks are finite in both coordinate outputs.
- Mean required-landmark visibility is at least 0.70.
- The captured posture is upright enough for a standing reference: hip angle at least 150°, knee angle at least 155°, and image-plane torso lean no more than 20°.
- Timestamps are strictly increasing.
- Standard deviation is no more than 4° at the hip, 4° at the knee, and 3.5° for torso lean.

These values are **capture-quality heuristics**, not universal technique or safety thresholds. A rejected reference produces no partial profile; the UI asks the user to stand tall, side-on, still, and fully in view.

An accepted profile stores medians for upright hip angle, knee angle, and gross torso lean, plus reference proportions, average visibility, and jitter. Saving or clearing a reference resets the in-flight analyzer state.

## Framing coach

Framing guidance is separate from swing assessment and never changes rep metrics. It reads the rate-limited normalized landmark output, transforms horizontal coordinates to match the displayed preview, and uses a visible head plus bilateral shoulder, hip, knee, wrist, ankle, and toe anchors. Current setup heuristics ask the user to:

- step into view when a stable core is unavailable;
- use a neutral “show your full body” cue when any required bilateral shoulder, hip, knee, wrist, ankle, or toe evidence is missing, because distance and readiness are ambiguous;
- step away when the observed landmark envelope touches an edge, or visible body height exceeds 80% of the frame;
- move closer when visible body height is below 55% of the frame;
- move left/right in the displayed frame when torso centre leaves the 37–63% horizontal region;
- turn side-on when aspect-corrected shoulder width relative to visible body height exceeds the side-view gate, or shoulder evidence is too uncertain to verify orientation;
- hold position only after the full framing sequence is satisfied.

These are presentation heuristics, not camera-distance measurements. A “position looks good” state means only that the tracked body occupies the intended image region; it cannot establish clear floor space, bell visibility, safe loading, or correct technique.

Visual state is always present. Optional speech requires correction states to remain stable for 800 ms and ready/finding states for 1,200 ms, enforces at least three seconds between different announcements, and repeats an unresolved correction no more than once every seven seconds. Automatic speech is disabled during active swing phases, for four seconds after recent movement or a tracking dropout, and during calibration, demo, pause, hidden-page, and ended-session states.

After explicit opt-in, the primary speech path uses the static `maritime-command-v2` candidate. It contains two original fictional Qwen-designed profiles: **Harbour**, a clean mid-low British baritone, and **Crown**, a clean mid-low British mezzo/alto. Both were designed locally from the same semantic contemporary-British leadership brief and exact reference transcript, with matched brisk pace, attack, confidence, disciplined warmth, and forward drive. Neither profile is a human coach recording, an imitation of a named person, or affiliated with a real military unit. Both are disclosed as AI-generated character voices, and neither is approved for release until blind human listening accepts its accent, energy, naturalness, and intelligibility.

The policy contains 11 exact messages. Every profile/message combination is committed as a mastered 24 kHz mono MP3, producing 22 files totalling 323,166 bytes. Harbour's phrases total 19,300 ms and Crown's total 19,133 ms (0.87% delta), and mean integrated loudness differs by 0.036 LU. Source code statically enumerates every asset URL, Vite emits hashed production assets, and the browser fetches only the selected profile's 11 same-origin files after opt-in. Each response is streamed under a fixed 15-second deadline into an exact manifest-sized buffer, with declared/actual overflow, short body, MIME, and SHA-256 checks before Web Audio decoding. Playback accepts only the exact typed message object; analyzer-generated or browser-supplied free text is never eligible. One source is owned at a time. Replacement and profile switching cancel stale playback; disabling, page hiding, session end, timeout, failure, and unmount also abort unfinished pack requests and release response readers. The context is suspended while inactive and closed on unmount.

The branded voice path has no runtime model or speech-provider request, server function, credential, WebRTC peer, WebSocket, microphone track, data channel, arbitrary URL, camera frame, video, or landmark transfer. If pack loading, integrity verification, decoding, or playback fails, visual guidance remains available and the app may use a browser-reported local English system voice for the same fixed message. That fallback voice's availability, accent, identity, quality, timing, and platform privacy behaviour vary by browser and operating system; it must not be described as Harbour or Crown. Speech recognition never participates. Generation provenance, mastering limits, release checks, and private-material handling are defined in [British Maritime Command voice pack](./VOICE_PACK.md).

## Assessability and abstention

The analyzer must be able to abstain. A frame is eligible for tracking only when:

- Ear, shoulder, hip, knee, ankle, and wrist landmarks are finite in both coordinate outputs.
- Aggregate tracking-landmark visibility is at least 0.58.
- Wrist visibility is at least 0.55.
- The side-view/framing heuristic is at least 0.45.
- Timestamps are finite, increasing, and no more than 350 ms apart.
- Recent hip motion is detectable; a stationary pose is not a swing assessment.

The UI applies an additional gate: combined confidence must be at least 0.62 and phase must not be `waiting`. Combined confidence is a capture-confidence signal derived from landmark visibility and camera quality; it is not movement quality.

When required landmarks, confidence, view quality, motion, timing continuity, or phase evidence is inadequate, the analyzer returns an unassessed frame:

- `phase: "waiting"`
- `feedback: []`
- no correction overlays
- the completed session rep count is preserved
- in-flight history and partial-rep state are cleared
- `score: 0`

The UI presents this as **Not assessed**, **Adjust view**, or **Ready when you are**. It must not convert abstention into a negative form judgment, a positive “clean” judgment, or a guessed cue.

## Ordered phase and rep model

The temporal model uses five public phases:

1. `waiting`: no assessable movement phase.
2. `backswing`: hip flexion exceeds the configured bottom threshold and is not already rapidly reversing.
3. `drive`: hip flexion is decreasing rapidly after an accepted backswing.
4. `float`: the hips have returned close to the upright reference and wrist midpoint is in the higher top range.
5. `lockout`: the hips have returned close to the upright reference and wrist midpoint is in the lower top range.

The internal rep state must advance in this order:

```text
idle -> backswing -> drive -> float|lockout -> counted rep
```

A top position reached without a recorded drive does not count. A rep also requires the hips to return inside the configured top range, wrist midpoint above the minimum top-height proxy, and at least 650 ms since the previous counted rep. A partial rep expires after 3,500 ms. Invalid timestamps, a tracking gap over 350 ms, or failed landmark/confidence gates clear the partial sequence without erasing already counted reps.

Current phase thresholds are heuristics relative to the upright reference. The bottom threshold is 36° of hip-flexion change for technique/conditioning or 42° for power, adjusted by −2° for a new user and +3° for an advanced user. The top threshold is 14°, or 10° for an advanced user. These values organize the state machine; they are not universal definitions of a correct swing.

## Observable feedback

Feedback is restricted to camera-observable proxies for the declared style:

- **View quality:** asks for a clearer side view when the framing/orientation heuristic is marginal but still assessable.
- **Hip versus knee contribution:** during the backswing, compares hip-flexion change with knee-flexion change and may cue “hinge more than you squat.” The ratio threshold is 1.45, or 1.65 for the advanced setting.
- **Hand height at the top:** may cue “let the bell float” when wrist midpoint rises above the selected shoulder-height range. This is a wrist proxy, not direct bell tracking or muscle-use measurement.
- **Gross tall finish:** compares image-plane torso lean and head-to-torso orientation with the upright reference and may cue against a marked neck crane or backward lean. It does not assess individual vertebrae or determine spinal alignment.
- **Sequence status:** reports that a rep is in progress, counted, or lacks enough evidence for an additional adjustment.

The implementation can generate several internal signals, but the UI prioritizes the first actionable `watch` or `fix` cue and shows only descriptive signal states such as **On track**, **Watch next rep**, or **Awaiting a clear full rep**. An “On track” state means no supported high-confidence adjustment was emitted for that observation window; it does not mean perfect form or safety.

Feedback thresholds vary with declared experience and focus. They are currently heuristic and require cue-by-cue validation against held-out kettlebell video and qualified-coach labels before effectiveness claims.

## Internal score contract

`AnalysisFrame.assessmentStatus` is the authoritative `"assessed" | "unassessed"` domain state used by the UI. `AnalysisFrame.score` remains numeric only for compatibility and internal regression work; unassessed frames currently also carry `0`, but consumers must not use that number to infer assessability.

The live UI intentionally does **not** display a universal form score. It displays view confidence, phase, rep count, observable signals, and an actionable cue. The internal nonzero calculation is not a validated measure of correctness, safety, injury risk, or coaching effectiveness and must not be exposed or marketed as one.

## Visual layers

The optional body, muscle, skeleton, and trail layers are illustrative renderings driven by pose landmarks and cue state. They do not depict measured anatomy, muscle activation, force, pain, tissue load, or injury risk. Muscle and trail layers are off by default. Coloured joint emphasis indicates a cue or tracking uncertainty, not pathology.

## Current limits

- Only the declared two-hand, shoulder-height, side-view hip-hinge mode is supported.
- The system assumes one visible user and does not classify alternate swing styles.
- There is no kettlebell detector; wrist midpoint stands in for hand/bell height.
- Monocular pose estimates are task-, device-, view-, clothing-, lighting-, body-, and occlusion-dependent.
- Gross head/torso and hip/knee proxies cannot measure segmental spinal position, balance, bracing, breathing, pain, exertion, muscle activity, internal loading, or injury risk.
- The clip analyzer requires three completed reps before returning a pointer. The live analyzer can still emit a provisional observable cue within one ordered cycle, so live technique output does not yet meet the three-repetition validated-release gate in the evidence specification and must not be presented as a validated assessment or repeatability result.
- The current “Recent reps” bars are presentation values derived from rep count and capture confidence, not measured cycle-to-cycle consistency.
- Calibration and feedback thresholds are not yet validated across the intended population or device matrix.
- A live app cannot clear a user for exercise, select a safe bell mass, diagnose a problem, or replace a qualified coach or healthcare professional.

## Implementation references

- Analyzer: [`src/lib/swingAnalyzer.ts`](../src/lib/swingAnalyzer.ts)
- Capture and calibration lifecycle: [`src/hooks/usePoseCoach.ts`](../src/hooks/usePoseCoach.ts)
- UI abstention and cue presentation: [`src/App.tsx`](../src/App.tsx)
- Exact spoken-message policy: [`src/lib/coachVoicePolicy.ts`](../src/lib/coachVoicePolicy.ts)
- Branded profiles and disclosure: [`src/lib/coachVoiceProfiles.ts`](../src/lib/coachVoiceProfiles.ts)
- Explicit asset map and integrity metadata: [`src/lib/coachVoiceAssets.ts`](../src/lib/coachVoiceAssets.ts), [`src/data/coachVoiceManifest.v2.json`](../src/data/coachVoiceManifest.v2.json)
- Web Audio pack and device-fallback lifecycle: [`src/lib/coachVoicePackClient.ts`](../src/lib/coachVoicePackClient.ts), [`src/hooks/useSpokenFramingCoach.ts`](../src/hooks/useSpokenFramingCoach.ts)
- Tests for fail-closed calibration, ordered reps, gaps, and sentinel output: [`src/lib/__tests__/swingAnalyzer.test.ts`](../src/lib/__tests__/swingAnalyzer.test.ts)
- Evidence, claims, validation, privacy, and accessibility boundary: [Evidence and Safety Specification](./EVIDENCE_AND_SAFETY.md)
