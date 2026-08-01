# KB FORM Technical Audit

**Audit date:** 2026-07-31

**Baseline:** commit `46deb16df76268e22885f044ba65ffc0d43a38eb` (`Build kettlebell form coach`, 2026-04-28)

**Reviewed branch/worktree:** `sergiopesch/video-clip-analysis`

## Executive finding

The committed baseline was a buildable proof of concept with a coherent browser-pose, analyzer, overlay, and 3D visualization scaffold. It was not evidence-ready: inference ran synchronously on the main thread, the rep state machine could accept discontinuous sequences, calibration was permissive, idle frames could receive positive feedback, dependencies included known high-severity advisories, and there were no lint or test gates.

This branch materially improves the engineering baseline. The current worktree passes lint, type-checking, 104 deterministic tests, production build verification, and a production dependency audit with zero known vulnerabilities. It adds worker-backed live and selected-clip inference, bounded frame submission, a 4–10 second crop/trim workflow, stricter abstaining analysis, a responsive and accessible interface, safer claims, CI configuration, and deployment-header defaults.

It is still a **prototype, not a validated form or safety system**. No physical camera session, real kettlebell swing, target-device performance run, coach-labelled video corpus, or motion-capture comparison was available in this audit. Those are release gates, not documentation footnotes.

## Scope and method

| Evidence | Method | What it establishes |
| --- | --- | --- |
| Baseline source | `git show HEAD:…` and an isolated `git archive HEAD` checkout | Behavior and build state of the committed baseline without current worktree changes |
| Current source | Static inspection of the current worktree | Implemented architecture and safeguards |
| Automated checks | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --json` | Local software quality gates on Node `v26.5.0` and npm `11.17.0` |
| Product evidence | Synthetic landmark tests, mocked UI/hook tests, and a local browser smoke run with a generated static video | Deterministic analyzer, clip protocol, and interface behavior only |

Build success does not establish camera compatibility, inference accuracy, coaching validity, accessibility with assistive technology, privacy at runtime, or safe exercise execution.

## What worked in the baseline

| Area | Verified baseline evidence | Qualification |
| --- | --- | --- |
| Install and compile | `npm ci` and `npm run build` succeeded in the isolated baseline checkout; the build included `tsc -b`. | This verifies compilation, not a live browser session. |
| Product scaffold | Source contained webcam acquisition, MediaPipe GPU-to-CPU fallback, pose overlay drawing, upright calibration, swing analysis, and a Three.js movement view. | These paths were present but were not exercised with hardware during this audit. |
| Separation of concerns | Geometry, landmarks, swing analysis, drawing, pose creation, and 3D rendering were separate modules. | The main React component still owned most runtime orchestration. |
| Narrow movement intent | The README and coaching model targeted a two-hand hip-hinge swing rather than every kettlebell movement. | Several metrics and claims exceeded what monocular pose alone can establish. |

## Baseline failures, ranked

Priority 1 is the highest product risk. “Fixed” below means the defect is covered by current source and deterministic tests where stated; it does not imply real-world coaching validation.

| Priority | Baseline failure and evidence | Current disposition |
| --- | --- | --- |
| 1 | **False-positive coaching states.** A single `loadedBackswing` flag could survive interrupted tracking and count a rep on a later top frame without an observed drive. The fallback feedback was “Pattern looks clean,” including frames with no active rep. | **Fixed in analyzer logic and synthetic tests.** Rep counting now requires ordered backswing → drive → top continuity, resets in-flight state after invalid/low-confidence input or a time gap, and returns an unassessed waiting frame with score `0`, no feedback, and no risk markers. See [`swingAnalyzer.ts`](../src/lib/swingAnalyzer.ts) and [`swingAnalyzer.test.ts`](../src/lib/__tests__/swingAnalyzer.test.ts). |
| 2 | **Calibration and metric overconfidence.** Calibration accepted 12 visible samples without a minimum duration, upright-posture gate, or stability limit. Frame-range variability was labelled smoothness; world-z depth contributed to cues and score; a `rehab` mode implied unsupported clinical scope. | **Code-level mitigation complete.** Calibration now requires adequate duration, sample count, valid ratio, visibility, upright angles, and stability. Motion smoothness uses time-local prediction error. Depth-based cues/scoring and `rehab` were removed; 3D muscle brightness is no longer presented as inferred activation. Thresholds remain heuristic pending athlete validation. |
| 3 | **Main-thread inference and monolithic delivery.** `detectForVideo()` ran synchronously inside a `requestAnimationFrame()` loop. The baseline emitted one 911.61 kB JavaScript chunk and raised Vite's over-500 kB warning. | **Architecture improved; runtime unverified.** Inference is in a module Worker, frame submission is capped at one in flight, `requestVideoFrameCallback()` is preferred, UI updates are rate-limited, and the 3D view is lazy-loaded behind an error boundary. Real latency, dropped-frame, memory, thermal, GPU, and CPU-fallback behavior still require device testing. |
| 4 | **No automated regression gates.** The baseline package had no `lint` or `test` scripts and no CI workflow. | **Fixed locally.** ESLint, Vitest, Testing Library, coverage thresholds, an aggregate `check` script, and [CI configuration](../.github/workflows/ci.yml) were added. The current 104 tests cover analyzer logic, trim/crop bounds, conservative clip aggregation, clip Worker envelopes and cleanup, settings snapshots, component focus, and application flows. Real camera, Worker-engine, rendering, and target-device paths remain open. |
| 5 | **Dependency and asset reproducibility/security.** Direct dependencies used semver ranges, the Heavy pose model URL used `latest`, and baseline `npm audit` reported two high-severity vulnerable packages (`vite` and transitive `postcss`). | **Fixed for the inspected lockfile and production runtime.** Direct versions are exact, Vite is `8.1.5`, and current full `npm audit` reports zero known vulnerabilities. Installation stages the locked MediaPipe runtime and revisioned model as same-origin assets; the model SHA-256 is enforced during install and build verification. |
| 6 | **Product, accessibility, and deployment boundaries were weak.** The baseline had no camera-free preview, limited safety/measurement caveats, no 3D error boundary, a network-exposed Vite dev host, and no deployment-header baseline. | **Substantially improved.** The branch adds preview mode, keyboard semantics, visible focus, reduced-motion and responsive styles, explicit stop/measurement language, loopback-only dev/preview hosts, and [`public/_headers`](../public/_headers). Manual assistive-technology testing and deployed-header verification remain open. |

## What is now fixed or implemented

| Change | Repository evidence | Verified level |
| --- | --- | --- |
| Tracking continuity and rep ordering | Analyzer state resets on malformed input, low confidence, non-monotonic time, or gaps over 350 ms; a rep needs backswing, drive, and top within the continuity window. | 14 deterministic analyzer tests pass. |
| Neutral abstention | Motionless, lost, truncated, or otherwise unassessed frames carry an explicit `assessmentStatus: "unassessed"`, waiting phase, score `0`, no feedback, and no joint-risk overlays. | Covered by analyzer tests. |
| Fail-closed calibration | At least 30 internally valid samples, 1.5 seconds, 80% valid input, adequate visibility, upright posture, and bounded jitter are required; the UI collects a stricter 48 samples over 2 seconds. | Stable, short, bent, and unstable synthetic cases are tested. |
| Safer feedback semantics | Unreachable/deceptive depth and finish checks were removed, range is no longer called smoothness, joint markers are deduplicated by highest severity, and an accepted top says only “Rep completed.” | Covered by analyzer tests and source inspection. |
| Responsive inference pipeline | [`usePoseCoach.ts`](../src/hooks/usePoseCoach.ts) transfers cropped/resized `ImageBitmap` frames to [`poseWorker.ts`](../src/workers/poseWorker.ts), maintains one in-flight frame, pauses clip media time during inference, closes frames on both Worker and transfer-failure paths, and stops camera tracks on session end/unmount. | Protocol paths are unit-tested and a local browser clip run completed; physical camera and target-device qualification remain. |
| Honest interface | [`App.tsx`](../src/App.tsx) distinguishes observable signals from safety, exposes “Not assessed,” removes rehabilitation, labels 3D anatomy as illustrative, and provides no-camera preview plus local clip selection. | Component/application tests and local desktop/mobile browser smoke checks pass. |
| Optional 3D path | `PoseScene` is dynamically imported and guarded so live coaching can continue if WebGL fails. Metric-driven muscle “activation” brightness was removed. | Build split verified; WebGL failure was not exercised in a real browser. |
| Reproducible quality gates | Exact dependency versions, lint/type/test/build scripts, analyzer coverage thresholds, and a GitHub Actions workflow are present. | All local gates and the aggregate `npm run check` pass; the remote workflow has not been observed. |
| Browser/deployment defaults | Dev and preview bind to `127.0.0.1`; a restrictive camera policy, CSP, framing, referrer, and content-type header baseline is included. | Configuration inspection only; the target host must apply equivalent headers. |
| Documentation boundaries | The README, [`coach-model.md`](coach-model.md), evidence specification, and technical roadmap now distinguish implementation facts, heuristic thresholds, research candidates, and release gates. | Source inspection; external claims still require their cited evidence and future product validation. |

## Measured before and after

These are single local runs, not performance benchmarks. Asset sizes are Vite's production-build output.

| Measure | Committed baseline | Current branch/worktree |
| --- | ---: | ---: |
| `npm run build` | Pass; Vite `8.0.10`; 1,739 modules; 403 ms | Pass; Vite `8.1.5`; 1,791 modules; 177 ms |
| Main/app JavaScript | 911.61 kB raw; 249.97 kB gzip | 254.41 kB raw; 79.87 kB gzip |
| Additional current chunks | None | pose Worker: 137.62 kB raw; lazy clip workspace: 26.35 kB raw / 8.06 kB gzip; lazy `PoseScene`: 561.09 kB raw / 140.66 kB gzip |
| CSS | 8.48 kB raw; 2.49 kB gzip | 31.68 kB raw; 7.38 kB gzip, plus four self-hosted Latin WOFF2 files |
| Chunk warning | Baseline main chunk exceeded Vite's default 500 kB threshold | No warning under the configured 600 kB threshold; the optional 3D chunk is still 560.57 kB |
| Lint | No script | Pass, zero warnings allowed |
| Type-check | Pass as part of build | Pass independently and as part of build |
| Automated tests | No script / zero repository tests | 7 files, 104 tests, all pass |
| `npm audit` | 2 high-severity vulnerable packages | 0 known vulnerabilities across the installed dependency tree |

The main/app chunk is 72.1% smaller raw and 68.0% smaller gzip, but that comparison excludes the separately loaded Worker, clip workspace, and optional 3D chunk. Build time differences are too noisy to treat as a speedup.

## Unverified and blocked release gates

| Gate | Current evidence | Required next evidence |
| --- | --- | --- |
| **Physical camera lifecycle** | Camera, pause, end, track cleanup, permission error, and device-end paths exist in source. | Run real HTTPS camera sessions covering allow/deny/revoke, start/pause/resume/end, tab backgrounding, camera loss, rotation, and repeated sessions. Confirm tracks and frames are released. |
| **Real swing and rep accuracy** | Analyzer tests use constructed landmarks; UI tests mock the pose hook. | Use fixed real videos and live swings from held-out athletes. Report rep-count precision/recall/F1, phase confusion, event timing error, false-clean rate, abstention coverage, and failures by view/device/body/clothing/lighting. |
| **Cue and score validity** | Current thresholds are fail-closed engineering heuristics and the UI explicitly disclaims safety. | Compare every cue separately with blinded dual-coach labels and agreement. Use motion capture or carefully annotated high-frame-rate reference data for kinematic error. Do not market a score as correctness or safety without validation. |
| **Calibration validity** | Synthetic tests reject short, bent, and unstable samples. | Measure success/retry rates and downstream angle error across body dimensions, clothing, lighting, camera height/distance, and natural postural variability. |
| **Browser/device performance** | Worker architecture and production build are present; one local build was measured. | Test the supported Chrome/Safari/Firefox and desktop/mobile matrix, GPU and CPU delegates, p50/p95 capture-to-result latency, accepted analysis rate, dropped frames, long tasks, memory, battery, and 10-minute thermal behavior. |
| **Privacy and offline behavior** | Repository code does not store or intentionally upload raw frames. Fonts, the locked WASM runtime, and the checksum-verified model are same-origin; the local browser's loaded-asset inventory contained no external resource and its warning/error log was empty. | Inspect production browser traffic and MediaPipe telemetry before claiming offline operation; verify no frames or landmarks enter logs or crash reports, and document retention/consent. |
| **Scene ambiguity and robustness** | Clip inference requests up to two poses and accepts evidence only when exactly one is returned; required full-body landmarks each have a visibility floor. This does not prove the scene is unambiguous, and live input still returns at most one pose. | Qualify a stronger multi-person/ambiguity gate for clip and live input; test cropping, occlusion, blur, low light, loose clothing, mirrored input, bystanders, and unsupported swing styles. |
| **Integration and accessibility** | Semantic controls, focus restoration, keyboard crop movement/resizing, reduced-motion styles, 44 px crop handles, and component tests exist. Local browser QA verified desktop and 390 px reflow without horizontal overflow. | Add Worker-engine/camera end-to-end tests; manually test screen readers, zoom/reflow, contrast, touch interaction, and reduced motion on target devices. |
| **CI and deployment** | A workflow and Netlify-style header file exist in the worktree. | Observe CI on the pushed branch with Node 24, deploy over HTTPS, verify emitted headers and camera Permissions Policy at the CDN, then run smoke and egress tests. |
| **Explicit assessability domain state** | The analyzer now returns an `assessed`/`unassessed` discriminant; the UI consumes that state directly. Numeric score `0` remains only for compatibility and regression work. | Migrate future consumers to the discriminant and remove the numeric score field once no downstream code needs it. |

The evidence and safety boundary is detailed in [`EVIDENCE_AND_SAFETY.md`](EVIDENCE_AND_SAFETY.md). The model/runtime qualification sequence and measurable promotion gates are in [`TECHNICAL_ROADMAP.md`](TECHNICAL_ROADMAP.md).

## Release position

The branch is a substantially safer and more maintainable prototype and is suitable for continued controlled development. It should not be represented as production-validated, clinically meaningful, injury-preventing, or universally correct. The shortest credible path to release is:

1. Make the current automated check and coverage workflow pass on the remote branch.
2. Verify same-origin runtime/model egress, caching, and integrity behavior across the supported browsers.
3. Pass physical camera, lifecycle, browser/device, and privacy-egress tests.
4. Validate rep counting, abstention, and each enabled cue against held-out real swings and qualified human labels.

Until those gates pass, “technique-awareness prototype” is the evidence-supported product description.
