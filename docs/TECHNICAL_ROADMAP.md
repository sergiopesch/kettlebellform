# Kettlebell Form Coach: Technical Roadmap

Status: implementation-aligned roadmap · Evidence checked: 1 August 2026 · Scope: browser camera capture, pose inference, swing analysis, performance, privacy, and validation

## Delivery labels

- **Current** describes the repository today.
- **Ship now** is the production baseline to implement before expanding the coaching model.
- **Next** starts only after the ship-now performance and safety gates pass.
- **Research** is an isolated experiment. It must not become the default runtime without the promotion evidence defined below.

Published results are identified as **Evidence**. Product and engineering choices are identified as **Decision** or **Target**. Targets are release criteria, not medical or biomechanical safety thresholds.

## Outcome

The app now keeps live and selected-clip pose inference off the main thread and bounds frame work so latency cannot grow into a stale-frame queue. The current production paths are:

```text
camera -> requestVideoFrameCallback -> one transferable ImageBitmap
       -> MediaPipe VIDEO mode (one pose) in a module Worker
clip   -> 4–10 s window + normalized ROI -> crop/downscale to <=640 px
       -> pause media time during each inference -> MediaPipe IMAGE mode (up to two poses)
       -> accept body evidence only when exactly one pose is returned
both   -> main-thread calibration/SwingAnalyzer
       -> overlay and latest-result React UI
```

This split is intentional: synchronous MediaPipe inference owns the expensive worker boundary, while `SwingAnalyzer` remains a lightweight, pure, directly testable main-thread state machine. Move the analyzer only if profiling shows it is a meaningful source of main-thread work.

Exact-pinned MediaPipe Pose Landmarker 0.10.35 with the Full model artifact at model path `/1/` is the **Current** engine. MediaPipe 1.x is a gated **Next** migration; the current published candidate is 1.0.1. The earlier 1.0.0 install cutoff was encountered during initial implementation, but availability is no longer the gate—side-by-side qualification is. WebGPU, WebNN, RTMLib/RTMPose, dense depth, and learned biomechanics remain **Research** until they outperform the current baseline on the project's own kettlebell dataset.

## Implemented baseline

| Area | Current implementation | Status |
| --- | --- | --- |
| Inference isolation | A dedicated module Worker creates MediaPipe, calls synchronous `detectForVideo()` for live input, and uses stateless `detect()` for selected clip frames. Camera permission, React, canvas, calibration, and `SwingAnalyzer` stay on the main thread. | **Implemented** |
| Frame scheduling and pressure | `requestVideoFrameCallback()` is primary, with a `requestAnimationFrame()` compatibility fallback. At most one `ImageBitmap` is being created or processed and there is no pending-frame queue. Live callbacks are skipped while busy; clip playback pauses through extraction/inference, then resumes at up to 4× on GPU or 2× on CPU so device latency cannot create invalid source-time gaps. Every bitmap is closed by the Worker or by main-thread cancellation, late-result, or transfer-failure cleanup. | **Implemented** |
| Reproducible versions | npm package and Worker version are exact `0.10.35`; install stages matching WASM from the locked package and verifies the Full model revision with SHA-256 before serving both from the app origin. Vite is exact `8.1.5`. | **Implemented** |
| Delegate fallback | The Worker attempts GPU/WebGL first and retries the same pinned Full model on CPU. | **Implemented; qualification remains** |
| Bundle loading | The Three.js movement scene is loaded with `React.lazy()` and `Suspense`, keeping it out of the initial application chunk. | **Implemented** |
| Test foundation | Vitest, Testing Library, coverage thresholds, analyzer continuity/assessment tests, clip utility and aggregation tests, Worker-protocol hook tests, and application tests are configured. | **Implemented; real corpus and target-device tests remain** |
| Initial assessment guard | Low tracking visibility, any missing required full-body landmark, wrist visibility, or camera quality clears tracking state and returns `assessmentStatus: "unassessed"`; clip results additionally require three completed reps, enough supported frames and coverage, and recurring evidence. Clinical/rehab goals are absent. | **Implemented; qualify thresholds and broaden capture checks** |

## Remaining architecture and product gaps

| Area | Implemented baseline | Gap to close |
| --- | --- | --- |
| Runtime qualification | MediaPipe 0.10.35 Full runs in a Worker with GPU-to-CPU fallback and reports per-frame inference time. | Add sustained browser/device baselines, capture-to-result latency, accepted-analysis rate, initialization failure, resource growth, and delegate-specific qualification. CPU must not silently present delayed coaching if it misses the release gate. |
| Runtime migration | Current package/WASM/model inputs are exact and mutually versioned. | Published candidate MediaPipe 1.0.1 still needs side-by-side fixed-clip, browser, performance, asset, and lifecycle qualification before adoption. |
| Browser acceleration | The code calls the MediaPipe `GPU` delegate. | MediaPipe Vision's Web GPU delegate uses WebGL, not WebGPU. The app should not claim WebGPU acceleration for this path. |
| Coordinate validity | Swing angles and wrist depth rely heavily on `worldLandmarks`; project docs call them meter-scale. | The Task API labels world coordinates in metres, while BlazePose's model card says its underlying z estimate comes from synthetic GHUM fitting and is up to scale rather than measured metric depth. Until swing-specific validation resolves that distinction, wrist z is a model-relative proxy—not measured bell depth or a basis for velocity, power, force, or load claims. |
| Signal quality | The analyzer fails closed below full-body, tracking, wrist, or camera-quality thresholds and returns an explicit assessed/unassessed discriminant. Clip IMAGE inference requests up to two poses and accepts evidence only when exactly one is returned. | Qualify the current gates and add direct blur/light, cadence, unsupported-style, and more robust scene-ambiguity checks; the two-pose result is an approximation, not proof that no bystander is present. |
| Side-view landmarks | Left and right joint angles and wrists are averaged. | A side view commonly occludes the far side. Per-joint near-side selection based on visibility/stability should be evaluated instead of unconditional averaging. |
| Coaching model | Goal/experience-dependent thresholds generate up to four internal per-frame feedback signals and a 0–100 score; the UI selects one current cue. Clinical/rehab modes are absent. | Thresholds are not yet validated against kettlebell ground truth or coach agreement. Add persistence, rep-level evidence, confidence, and a refractory period so the selected cue does not change too rapidly. |
| Kettlebell path | Wrist midpoint is treated as the bell/hand path; entered bell mass only adjusts one cue's severity. | MediaPipe does not detect the kettlebell. The app cannot infer bell centre, mass, forces, torque, spinal load, or muscle activation from these landmarks. |
| Testing and observability | Unit/application tests, clip scheduling/cleanup protocol tests, coverage gates, and a documented public-video transport matrix now exist. Local Chrome runs exercised H.264, VP8, VP9, VFR, exact EOF, damaged-media recovery, no-person abstention, upload, crop, analysis, focus restoration, 390 px reflow, and the loaded-asset inventory. | Automate the public transport matrix; add a consented coach-labelled accuracy corpus, target-device performance baselines, cue metrics, screen-reader testing, and production egress tests. |
| Privacy and supply chain | Fonts, the locked WASM runtime, and the checksum-verified model are staged at install and served from the application origin. Production CSP permits only same-origin font, runtime, model, and connection paths; a local browser asset inventory found no external resource. | Audit production browser egress and MediaPipe telemetry before claiming offline operation or first-party-only delivery. |

## ADR-001: worker-owned inference with fresh-frame backpressure

**Status:** **implemented** for the current 0.10.35 baseline; qualification and telemetry remain.

### Decision

1. A dedicated module Worker owns MediaPipe initialization, live `detectForVideo()`, clip `detect()`, running-mode changes, delegate fallback, and model cleanup only.
2. The main thread owns camera permission, video presentation, calibration, the lightweight/pure `SwingAnalyzer`, overlay/React rendering, and user controls.
3. `HTMLVideoElement.requestVideoFrameCallback()` is the primary scheduler. Its media timestamp is carried with the frame; motion is not derived from frame counts. Clip playback pauses while a sampled frame is inferred so slower hardware does not skip through the analyzer's continuity window.
4. Enforce a queue invariant of **one `ImageBitmap` in flight and no pending bitmap**. `inFlight` covers bitmap creation plus worker processing.
5. If another camera callback arrives while busy, skip that frame. Never append to or replace within a FIFO queue.
6. Transfer the `ImageBitmap` to the Worker, which closes it in `finally`. If transfer throws synchronously, close it on the main thread. An `OffscreenCanvas` or other worker-safe image source may be qualified later as a compatibility fallback.
7. Return inference timing and the landmarks needed by the main-thread analyzer and overlay. Do not retain or transmit raw RGB frames.

Conceptual scheduling contract:

```text
onVideoFrame(frame):
  if workerBusy:
    skip frame
    return
  workerBusy = true
  bitmap = createImageBitmap(frame)
  transfer(bitmap)

onWorkerResult(result):
  workerBusy = false
  analyze and present(result)

onSelectedClipFrame(frame):
  pause clip media time
  crop and resize to <=640 px
  transfer one bitmap and await its result
  resume playback, or finish/cancel without a queue
```

### Why

**Evidence:** MediaPipe's Web guide says `detect()` and `detectForVideo()` are synchronous and block the calling thread, and recommends Web Workers. [`requestVideoFrameCallback()`](https://wicg.github.io/video-rvfc/) fires for presented video frames and supplies timing/drop metadata. [WebCodecs](https://www.w3.org/TR/webcodecs/) recommends worker-based real-time media pipelines, permits `VideoFrame` transfer without copying the underlying resource, and requires timely resource release.

**Decision:** one-in-flight/drop-while-busy processing is more valuable for live coaching than processing every old frame. It prevents latency from growing when inference is slower than capture. Keeping `SwingAnalyzer` on the main thread avoids unnecessary structured-clone/state complexity while it remains lightweight; profiling, not architectural symmetry, is the trigger to move it.

### Fallbacks

- If `requestVideoFrameCallback()` is unavailable, the current compatibility path uses `requestAnimationFrame()`, carrying the rAF timestamp for live input and reading `video.currentTime` for clip source time, still through the Worker and under the same busy-frame rule.
- If transferable `ImageBitmap` is unavailable, use a qualified worker-safe image source. Do not silently return to continuous main-thread inference.
- If GPU initialization fails, retry the same pinned model in the CPU worker.
- If both worker paths fail, disable live coaching and show a compatibility diagnostic. Video preview may remain available; fabricated or severely delayed scoring may not.
- `MediaStreamTrackProcessor` is a later progressive enhancement, not a ship-now dependency, because browser exposure still varies. [W3C draft](https://www.w3.org/TR/mediacapture-transform/)

## ADR-002: preserve 0.10.35 and gate MediaPipe 1.x

**Status:** exact-pinned 0.10.35 is **implemented**; 1.0.1 is the current gated **Next** candidate.

### Decision

- Keep `@mediapipe/tasks-vision` exact at `0.10.35`, load matching `0.10.35` WASM, and use the Pose Landmarker **Full** model artifact at versioned path `/1/` for the current baseline. There is no caret dependency or mutable `latest` model URL in the shipped path.
- Record the package version, model path and eventually its SHA-256, delegate, thresholds, and app build in each diagnostic session. Self-host the exact matching WASM and model before making an offline or first-party-only claim.
- Treat the 1.x upgrade as an application migration, not an automatic dependency update. Version 1.0.0 was unavailable through the project registry during initial implementation; 1.0.1 is now published, so qualification—not package discovery—is the remaining gate.
- Qualify 1.0.1 with a specific **Full** model artifact. If Full on CPU misses the release gate, report an unsupported live-analysis tier instead of silently changing the measurement model. Lite/Heavy device tiering is a later qualified change.
- Preserve the immutable 0.10.35 package/WASM/model combination through the first qualified 1.x release window. Introduce a project-owned landmark schema before running engines side by side. If both must coexist in one canary build, isolate 0.10.35 behind an npm alias and separate dynamic chunk; do not mix one version's JavaScript with another version's WASM.

### Migration qualification

Before adopting 1.0.1, run 0.10.35 and 1.0.1 against the same fixed clip corpus and target browsers. The 1.0.1 path must pass:

- worker initialization and cleanup on GPU and CPU;
- expected 33-landmark schema and finite values;
- monotonic timestamp and frame-ID behavior;
- no unbounded frame or GPU-resource growth;
- rep/phase/quality-gate regression comparisons;
- p50/p95 inference and capture-to-result latency;
- visual overlay alignment after mirroring/cropping;
- camera start, pause, resume, device rotation, background, and permission-revocation flows;
- a network-egress test with self-hosted assets.

### Rollback

Canary 1.0.1 behind a build/runtime engine flag that does not require sending camera data off-device. If it causes initialization failures, material latency regression, resource growth, or clip-regression failures, keep or redeploy the immutable 0.10.35 build. A dual-runtime canary is optional and must use the isolated alias/chunk described above. Preserve the recorded engine/model version so sessions across the rollback are not compared as if they used one measurement system.

**Evidence:** npm lists `@mediapipe/tasks-vision` 1.0.0 as published on 28 July 2026 and 1.0.1 as the current `latest`, published on 31 July 2026. That short production history supports a measured migration rather than an automatic upgrade. [npm package versions](https://www.npmjs.com/package/%40mediapipe/tasks-vision?activeTab=versions) The official model card reports higher 2D landmark accuracy for Heavy than Full and Lite, but its performance numbers are old native TFLite measurements, not Web guarantees. [BlazePose GHUM model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf)

## Runtime choices

| Runtime/model | Delivery state | Decision and promotion requirement |
| --- | --- | --- |
| MediaPipe Pose Landmarker 0.10.35 Full, module Worker, GPU/WebGL with CPU fallback | **Current / implemented** | Exact-pinned production baseline: package and WASM `0.10.35`, model artifact `/1/`. Complete performance, privacy, and device qualification without changing those inputs. |
| MediaPipe Pose Landmarker 1.0.1 Full | **Next / gated** | Run the full side-by-side migration suite before adoption. Keep 0.10.35 as the reproducible rollback. |
| MediaPipe Lite/Heavy | **Next** | Select only from measured device tiers. Heavy must never be the blind CPU fallback. |
| ONNX Runtime Web + RTMPose 26-keypoint | **Research** | The 2026 cross-framework exercise study found RTMLib materially better than MediaPipe in controlled side views, but RTMLib is not a browser drop-in: it requires a person detector, ONNX preprocessing/postprocessing, operator checks, model/data-license review, and target-device benchmarks. Promote only after it wins the project's swing dataset without unacceptable load/latency cost. [RTMPose paper](https://arxiv.org/abs/2303.07399), [RTMLib](https://github.com/Tau-J/rtmlib), [2026 comparison](https://doi.org/10.1109/TPAMI.2026.3672463) |
| WebGPU | **Research runtime for the RTMPose adapter** | MediaPipe Web Vision currently uses WebGL, so WebGPU does not accelerate the ship-now engine. ONNX Runtime WebGPU is promising, but requires feature and operator detection, WASM fallback, profiling, and GPU-resource lifecycle tests. [MediaPipe WebGPU issue](https://github.com/google-ai-edge/mediapipe/issues/5826), [ONNX Runtime WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) |
| WebNN | **Research/watchlist** | The specification is a Candidate Recommendation Draft and browser support is not yet a dependable default. Keep an execution-provider adapter boundary, but do not make WebNN a production requirement. [WebNN specification](https://www.w3.org/TR/webnn/) |
| MoveNet | Not selected | Its 17 landmarks omit useful foot/hand detail, and the 2026 comparison reported worse aggregate and side-view angle error than the selected challengers. [TensorFlow.js pose models](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/README.md) |
| Dense monocular depth | **Research/watchlist** | It does not make BlazePose landmarks, the unseen kettlebell, or biomechanical forces ground truth. Evaluate only for a narrowly defined visual-depth feature after the pose and cue pipeline is validated. |
| Kettlebell detector/keypoint model | **Research** | This is the honest route to bell-centre trajectory. It needs a representative labelled dataset and a compute-budget study; until then, label wrist trajectory as a wrist proxy. |

## Browser support and graceful degradation

Feature-detect capabilities; do not choose a path from the user-agent string.

| Capability | Preferred path | Fallback |
| --- | --- | --- |
| Camera | HTTPS `getUserMedia()`, requested only after a user action, `audio: false`; use actual track settings returned by the browser. | Explain permission/security failure and support prerecorded regression clips in development only. Camera capture is personally identifying and requires explicit consent. [Media Capture specification](https://www.w3.org/TR/mediacapture-streams/) |
| Frame callback | `requestVideoFrameCallback()` with `metadata.mediaTime`. Add metadata-derived capture/presentation and dropped-frame telemetry when qualified. | Current `requestAnimationFrame()` compatibility loop: its callback timestamp for live input, advancing `video.currentTime` for clip input, and the same Worker/backpressure rule. |
| Inference | Exact-pinned MediaPipe 0.10.35 Full with GPU/WebGL delegate in the module Worker. | The same pinned Full model on CPU in the Worker; disable live analysis if it misses the performance gate. MediaPipe 1.0.1 and Lite/Heavy tiering require separate qualification. |
| Frame transport | One transferable `ImageBitmap` in flight; skip callbacks while busy and close the bitmap in the Worker. | A qualified worker-compatible image source with the same one-in-flight/no-pending bound. |
| Overlay | Main-thread canvas showing only the latest accepted result. | Reduce overlay complexity/rate before reducing analysis correctness. Offscreen rendering is optional. |
| ONNX challenger | `navigator.gpu` plus successful model/operator initialization. | WASM SIMD; multithreaded WASM only under successful cross-origin isolation. [ONNX Runtime performance guide](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html) |
| Cross-origin isolation | Self-hosted assets with tested COOP/COEP when WASM threads are introduced. | Single-threaded WASM. Do not break camera/model loading merely to force threads. |

Chrome, Safari, and Firefox have shipped WebGPU on an expanding set of platforms, but that does not remove device/driver variability. [Chrome 113 announcement](https://developer.chrome.com/blog/webgpu-release), [Safari 26 announcement](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/), [Firefox 141 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141)

## Coaching and safety contract

These changes belong in **ship now** or the cue must remain disabled:

- Preserve the explicit assessed/unassessed result across future consumers. Do not show a numeric form score or “pattern looks clean” when required landmarks, framing, side angle, blur/light, or cadence fail.
- The clip path's two-pose IMAGE check is implemented as a conservative approximation and still needs scene-ambiguity qualification. Add an equivalent qualified check for live input; never assume `numPoses: 1` proves only one person is visible.
- State that world z, `depthTravel`, `spineStack`, projected anatomy, and muscle brightness are coaching proxies. They are not metric depth, lumbar curvature, EMG, force, power, torque, or injury-risk measurements.
- Keep clinical/rehab modes absent until a clinician-defined protocol and population-specific validation exist.
- Support only the declared two-hand hardstyle/shoulder-height protocol in the first validated release. Different swing styles have different timing and kinetics. [Swing-style study](https://pmc.ncbi.nlm.nih.gov/articles/PMC5455182/)
- Build on the current one-cue UI by moving feedback from per-frame signals to phase/rep evidence: require persistence, emit one short actionable cue, then use a refractory period.
- Treat expert hip-versus-shoulder ROM and proximal-to-distal timing as hypotheses to validate, not copied universal thresholds; the source study included only four experts and three beginners. [Expert/beginner study](https://e-kjab.org/archive/detail/5)
- Offer cycle-to-cycle consistency as a descriptive measure before claiming correctness. A 2026 one-arm study supports reproducibility as a promising signal but does not validate this app's technique or two-hand protocol. [2026 kettlebell study](https://journal.kci.go.kr/jksci/archive/articleView?artiId=ART003338903)
- Never infer safety from a score. A small biomechanics study estimated substantial lumbar compression and unique shear during swings, loads a monocular pose system cannot measure. [McGill and Marshall](https://pubmed.ncbi.nlm.nih.gov/21997449/)

## Validation plan and metrics

### Reference data

Build a consented, versioned swing corpus covering supported style, skill level, body dimensions, skin tone, clothing, lighting, occlusion, camera side/height/distance, device, browser, frame rate, and kettlebell load. Split train/tune/test data by athlete, never by frame or rep. Use fixed clips for software regression, two qualified coaches for technique labels and agreement, and a smaller synchronized motion-capture or carefully annotated high-frame-rate subset for kinematics and phase events.

Generic pose benchmarks cannot replace this dataset. In a 2026 Vicon exercise comparison, weighted side-view angle MAE was 17.63 degrees for MediaPipe and 7.62 degrees for RTMLib, while the ranking changed across views. [IEEE TPAMI study](https://doi.org/10.1109/TPAMI.2026.3672463) Another Qualisys study found MediaPipe squat peak-angle MAE of 7.6 degrees and motion-angle MAE of 8.3 degrees, but much larger errors for some other exercises. [MediaPipe/Qualisys study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10781343/)

### Required dashboards

| Dimension | Metrics |
| --- | --- |
| Runtime | model/WASM load failure rate; time to first pose; inference p50/p95; capture-to-result p50/p95; accepted analysis Hz; captured/processed/skipped frame counts; worker restarts; memory/GPU-resource trend; 10-minute thermal/battery behavior. |
| UI | inference-related main-thread long tasks; overlay FPS; input responsiveness while inference and Three.js are active. |
| Kinematics | per-joint and per-phase angle MAE/RMSE; Bland-Altman bias and limits of agreement; phase-event timing error; missing/low-confidence landmark rate. Report by view, engine, device, and participant group. |
| Functional | rep-count precision/recall/F1; phase confusion matrix; calibration success/retry rate; session-reset correctness. |
| Coaching | per-cue precision, recall, specificity, false-clean rate, coach agreement, confidence calibration, abstention coverage and risk. Validate every cue separately. |
| Robustness | results under cropping, blur, poor light, loose clothing, partial occlusion, mirrored feeds, device rotation, 30/60 FPS, and CPU/GPU fallbacks. |
| Privacy | raw-frame persistence checks; third-party network requests; camera track shutdown; deletion/export behavior; logs/crashes inspected for frames, landmarks, and session identifiers. |

### Proposed engineering targets

These are **Targets**, not research-derived safety thresholds:

- no unbounded queue: maximum one `ImageBitmap` in flight and zero pending bitmaps at all times;
- p95 capture-to-result latency at or below 150 ms on the agreed baseline devices;
- at least 20 accepted analyses per second during a sustained session, or an explicit lower-performance mode that still meets cue timing tests;
- no inference work on the main thread and no inference-caused long task;
- no score/cue outside the quality gate;
- no promotion of a cue until its accuracy, false-clean risk, and abstention behavior are reviewed against coach labels;
- no production model/runtime promotion based only on COCO PCK/AP or a native-device FPS claim.

## Phased roadmap

### Phase 0 — **Current:** responsive, reproducible code baseline

- Exact-pin `@mediapipe/tasks-vision`, matching WASM, and the Worker-reported version at `0.10.35`, and select the Full model at versioned path `/1/`.
- Run MediaPipe initialization, synchronous inference, GPU-to-CPU fallback, and cleanup in a module Worker.
- Schedule with `requestVideoFrameCallback()` and transfer at most one `ImageBitmap`; skip frames while busy and close each bitmap in the Worker.
- Keep calibration and the lightweight/pure `SwingAnalyzer` on the main thread.
- Exact-pin Vite 8.1.5 and lazy-load the Three.js movement scene.
- Establish Vitest/application tests and analyzer coverage thresholds.

**Exit:** **complete in the repository.** This is the baseline every subsequent phase must preserve or deliberately supersede through qualification.

### Phase 1 — **Ship now:** qualify and preserve the current baseline

- Add fixed representative clips and capture current 0.10.35 outputs, rep counts, phases, scores, and latency.
- Introduce a project-owned `PoseEngine`/result schema and record engine/model/backend versions.
- Self-host exact copies of the current WASM and model assets and record checksums.
- Add initialization, Worker lifecycle, frame-skip/cleanup, browser performance, network-egress, and sustained-session tests.
- Qualify GPU/WebGL and CPU fallbacks; disable live analysis when a path misses the release gate.

**Exit:** 0.10.35 is reproducible without third-party runtime fetches; p95 latency, one-in-flight, privacy, browser/device, and rollback checks pass.

### Phase 2 — **Ship now:** honest quality and privacy boundaries

- Extend the current fail-closed capture gate while preserving its explicit `unassessed` state.
- Demote world-z, wrist-path, spine, and muscle signals to explicitly named proxies.
- Keep clinical/rehab modes absent, restrict the shipped protocol, and add persistence/refractory behavior to the current one-cue presentation.
- Self-host runtime/model assets; verify the implemented end/unmount track shutdown and add background/permission-revocation handling; retain no raw frames by default.
- Audit MediaPipe metric egress and either obtain required consent or select a verified telemetry-free path. MediaPipe says input is processed locally but performance/utilization metrics are sent to Google. [Official privacy notice](https://github.com/google-ai-edge/mediapipe#privacy-notice)

**Exit:** low-quality or unsupported motion cannot receive a positive score; network and camera-lifecycle tests pass; user-facing claims match the measurement limits.

### Phase 3 — **Next:** qualify MediaPipe 1.0.1

- Install 1.0.1 only in a migration branch; do not loosen the shipped exact pin or discover a runtime version dynamically.
- Pin the 1.0.1 package, matching WASM, and one specific Full model artifact in a candidate build.
- Run the full migration qualification against the immutable 0.10.35 clip and browser/device baseline.
- Canary behind an engine flag, exercise rollback, and promote only if accuracy, latency, lifecycle, privacy, and resource gates pass.

**Exit:** 1.0.1 is reproducible, passes all migration gates, and retains an exercised 0.10.35 rollback; otherwise 0.10.35 remains current.

### Phase 4 — **Next:** validate the coaching model

- Collect the consented swing/reference dataset and dual-coach labels.
- Replace unconditional left/right averaging with the best validated side-selection method.
- Tune phase hysteresis and confidence-aware filtering from timestamps, preserving reversal timing.
- Calibrate thresholds and cue confidence per supported style; release cues individually behind evidence gates.
- Add user-visible consistency and confidence histories only after test-retest reliability is known.

**Exit:** the required dashboards are stratified by device/view/style, and each enabled cue has documented performance and failure conditions.

### Phase 5 — **Research:** challenger engines

- Export and integrate an RTMPose 26-keypoint ONNX pipeline behind `PoseEngine`.
- Benchmark WebGPU, WASM SIMD/threads, detector cadence, graph capture, I/O binding, memory, thermals, and model load time.
- Shadow-compare MediaPipe and RTMPose on the fixed corpus and held-out swing set.
- Maintain a WebNN adapter spike, but do not use it in production while default browser support remains incomplete.

**Promotion gate:** the challenger must materially improve cue-relevant angle/phase accuracy and false-clean risk on held-out athletes while meeting load, latency, privacy, license, and browser-fallback requirements.

### Phase 6 — **Research:** new measurements

- Train/evaluate a tiny kettlebell detector or bell keypoint model for true bell-centre trajectory.
- Evaluate optional synchronized second-camera analysis for a high-friction “pro” mode.
- Track physics-informed and temporal biomechanics research, but require kettlebell-specific replication before exposing new measurements. Recent methods are promising preprints, not production validation. [Physics-informed BlazePose refinement](https://arxiv.org/abs/2512.06783), [Pose-to-Biomechanics](https://arxiv.org/abs/2607.08725)

## Primary source index

- [MediaPipe Pose Landmarker Web guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [MediaPipe Pose Landmarker task and model overview](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
- [Official BlazePose GHUM model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [ONNX Runtime Web performance guidance](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- [RTMPose paper](https://arxiv.org/abs/2303.07399)
- [Official MMPose RTMPose project](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose)
- [2026 monocular pose comparison](https://doi.org/10.1109/TPAMI.2026.3672463)
