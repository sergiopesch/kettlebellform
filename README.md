# KB FORM

[![CI](https://github.com/sergiopesch/kettlebellform/actions/workflows/ci.yml/badge.svg)](https://github.com/sergiopesch/kettlebellform/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sergiopesch/kettlebellform/actions/workflows/codeql.yml/badge.svg)](https://github.com/sergiopesch/kettlebellform/actions/workflows/codeql.yml)
[![Live app](https://img.shields.io/badge/live-kettlebellform.vercel.app-c9f970)](https://kettlebellform.vercel.app)

An on-device, browser-based technique-awareness coach for one deliberately narrow movement: the two-hand, shoulder-height, hip-hinge kettlebell swing.

[Open KB FORM](https://kettlebellform.vercel.app) · [Read the technical audit](docs/AUDIT_REPORT.md) · [Review the evidence boundary](docs/EVIDENCE_AND_SAFETY.md)

![KB FORM coaching preview](docs/screenshots/kb-form-preview-desktop.jpg)

KB FORM turns a side-view camera feed or a locally selected video clip into confidence-aware movement cues without sending video frames to an application server. It is a general-wellness engineering prototype—not a safety verdict, medical device, injury predictor, or replacement for a qualified coach.

## Product experience

- **Camera-first setup:** clear framing, distance, lighting, movement, and space guidance before permission is requested.
- **Local clip review:** choose a natively supported video up to 120 seconds and 200 MiB, then select a continuous 4–10 second analysis window and normalized spatial frame containing at least three complete swings.
- **No-camera preview:** the complete coaching interface can be explored without activating a camera.
- **Fail-closed analysis:** malformed, stale, interrupted, low-visibility, or out-of-order pose sequences return **Not assessed**.
- **Ordered repetition logic:** a rep requires a continuous backswing → drive → float/finish sequence.
- **One useful cue at a time:** feedback is limited to observable movement patterns supported by the current landmarks.
- **Responsive and accessible controls:** keyboard navigation, focus management, live status semantics, reduced motion, 44 px touch targets, and layouts tested down to 320 px.

### Camera setup

![Desktop camera setup](docs/screenshots/kb-form-camera-setup.jpg)

<img src="docs/screenshots/kb-form-camera-setup-mobile.jpg" alt="KB FORM mobile camera setup" width="390" />

### Local clip review

The repository's clip workflow keeps the complete source available for local preview while sending only the selected time window and spatial frame through pose analysis. The selection is non-destructive: KB FORM does not upload, persist, transcode, or create a shortened copy of the video, and clip names, frames, and results are excluded from analytics.

Video decoding uses the browser's native media stack. Unsupported containers or codecs fail closed with a format message rather than being transferred elsewhere.

![Local clip upload](docs/screenshots/kb-form-clip-upload.jpg)

![Ten-second clip and crop editor](docs/screenshots/kb-form-clip-editor.jpg)

![On-device kettlebell swing analysis](docs/screenshots/kb-form-clip-analyzing.jpg)

![Fail-closed clip result](docs/screenshots/kb-form-clip-result.jpg)

## Runtime architecture

```text
camera → requestVideoFrameCallback → temporal VIDEO detection
local clip → 4–10 s window → normalized ROI → crop/downscale max 640 px
           → sample at no more than 15 fps → stateless IMAGE detection
           → detect up to two poses → accept evidence only when exactly one is found
both → one transferable ImageBitmap in flight, with no frame queue
  → dedicated MediaPipe inference Worker
  → landmark validity, visibility, and continuity gates
  → deterministic SwingAnalyzer state machine
  → confidence-aware cue and overlay UI
```

The initial app bundle stays separate from the Worker and the optional Three.js movement view. Inference prefers GPU and retries on CPU with a fresh MediaPipe module loader if GPU initialization fails. Frame responses are correlated to an exact Worker, job, and frame; cancelling or timing out an already-transferred frame replaces only that Worker and keeps new analysis disabled until the replacement reports ready.

MediaPipe `0.10.35`, its SIMD WASM runtime, and the full float16 pose model are pinned. `npm ci` copies the runtime from the locked package, downloads the revisioned model, verifies its SHA-256 digest, and stages it with the brand fonts as same-origin production assets. Runtime camera and clip sessions therefore do not depend on Google Fonts, jsDelivr, or Google Storage.

## Coaching and claims boundary

The current analyzer can report pose visibility, swing phase, completed rep count, hinge/knee relationships, shoulder lift, torso/head stack, and camera quality when evidence is sufficient.

Ordinary monocular pose landmarks cannot measure pain, breathing, bracing, muscle activation, spinal load, tissue capacity, kettlebell force, or injury risk. The body, region, skeleton, trail, and optional 3D layers are illustrative views—not anatomical or clinical measurements.

Stop for pain, dizziness, unusual breathlessness, or loss of bell control. New lifters benefit from in-person instruction.

## Local development

Requirements:

- Node.js 24
- npm 11
- A modern browser with module Workers, WebAssembly, `ImageBitmap`, and camera APIs

```bash
npm ci
npm run dev
```

Open the printed `127.0.0.1` URL. Use **Preview coaching** for the camera-free demonstration, **Start camera** for live analysis, or **Choose video** for the local clip workflow. Clip support depends on the browser's native decoders.

### Quality commands

```bash
npm run check          # lint + typecheck + coverage + verified production build
npm test               # deterministic unit and component tests
npm run test:watch     # local test loop
npm run audit:prod     # production dependency audit
npm run preview        # serve the production build locally
```

`npm run build:verify` enforces required deployment files, the model checksum, same-origin runtime policy, self-hosted font budget, security configuration, SPA fallback, source-map policy, initial/chunk budgets, and a total-output budget.

## DevOps

- GitHub Actions runs the full quality gate on pull requests and `master`.
- CodeQL scans JavaScript and TypeScript on pull requests, pushes, a weekly schedule, and manual runs.
- Dependabot groups weekly npm and GitHub Actions updates.
- CI uploads the verified production build and coverage report for seven days.
- Vercel serves the production app over HTTPS with restrictive CSP, camera permissions, frame protection, immutable hashed/runtime asset caching, and SPA deep-link rewrites.
- Netlify/Cloudflare-compatible `_headers` and `_redirects` files preserve the same static-host defaults.

## Validation status

Automated tests cover calibration, tracking loss, ordered rep phases, abstention, malformed input, feedback/risk behavior, setup UI, and camera request/cancellation lifecycle. Browser QA covers the deployed setup and preview flows at desktop and mobile sizes.

The remaining release gates require real evidence: physical camera sessions, held-out athlete videos, qualified coach labels, target-device performance/thermal testing, native clip codec/orientation coverage, trim and crop accessibility testing, privacy-egress inspection, and motion-capture comparison where kinematic claims require it.

## Documentation

- [Technical audit](docs/AUDIT_REPORT.md)
- [Evidence and safety specification](docs/EVIDENCE_AND_SAFETY.md)
- [Technical roadmap](docs/TECHNICAL_ROADMAP.md)
- [Coaching model](docs/coach-model.md)
- [Generated and source assets](docs/assets.md)

## License

No open-source license has been granted yet. The repository is publicly readable, but reuse rights remain reserved until a license is added.
