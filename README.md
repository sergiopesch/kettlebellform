# KB FORM

[![CI](https://github.com/sergiopesch/kettlebellform/actions/workflows/ci.yml/badge.svg)](https://github.com/sergiopesch/kettlebellform/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sergiopesch/kettlebellform/actions/workflows/codeql.yml/badge.svg)](https://github.com/sergiopesch/kettlebellform/actions/workflows/codeql.yml)
[![Live app](https://img.shields.io/badge/live-kettlebellform.vercel.app-c9f970)](https://kettlebellform.vercel.app)

A browser-based technique-awareness coach for one deliberately narrow movement: the two-hand, shoulder-height, hip-hinge kettlebell swing. Visual pose analysis stays on-device.

[Open KB FORM](https://kettlebellform.vercel.app) · [Read the technical audit](docs/AUDIT_REPORT.md) · [Review video compatibility](docs/VIDEO_COMPATIBILITY.md) · [Review the evidence boundary](docs/EVIDENCE_AND_SAFETY.md)

![KB FORM coaching preview](docs/screenshots/kb-form-preview-desktop.jpg)

KB FORM turns a side-view camera feed or a locally selected video clip into confidence-aware movement cues without sending video frames to an application server. It is a general-wellness engineering prototype—not a safety verdict, medical device, injury predictor, or replacement for a qualified coach.

## Product experience

- **Full-frame adaptive camera:** Room view requests an environment-facing 4:3 feed when the browser supports it, Selfie view remains available, and both the preview and pose overlay use the complete uncropped camera frame. After permission, exposed cameras can be selected explicitly.
- **Opt-in AI voice framing:** fixed camera-positioning cues can be rendered by `gpt-realtime-2.1` through output-only WebRTC using one of two disclosed British command-style profiles. The male-presentation profile uses OpenAI's built-in `cedar` voice and the female-presentation profile uses built-in `marin`; neither profile is a cloned or custom voice.
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

Video decoding uses the browser's native media stack. Clean end-of-file, native media errors, frame extraction, and pose inference have separate lifecycle signals and watchdogs, so a completed clip is not mistaken for a stalled decoder. Detected unsupported, damaged, or incomplete media fails closed with specific recovery guidance rather than being transferred elsewhere. The [public-video compatibility matrix](docs/VIDEO_COMPATIBILITY.md) records the tested sources, hashes, transformations, outcomes, and remaining device coverage.

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

optional voice opt-in → receive-only WebRTC + signed 15-minute session capability
  → browser sends an allowlisted cue ID to same-origin /api/realtime-cue
  → trusted server maps ID to fixed text over an OpenAI sideband control channel
  → gpt-realtime-2.1 audio with cedar or marin; no browser event channel
  → browser-reported local English speech fallback if available
```

Live capture requests a best-effort native 4:3 mode with browser cropping disabled, inspects the granted track rather than assuming a lens, and applies minimum zoom only when an already-authorized track explicitly exposes a safe numeric range. Camera labels are never treated as machine-readable proof of field of view. The UI letterboxes mismatched aspect ratios with `object-fit: contain`, keeping presentation aligned with the full frame already sent to inference. Camera switching stops the old track before requesting an explicitly selected `deviceId`, and unavailable devices fall back without retrying denied permission. Mirroring follows reported track metadata; a visible mirror control is the honest fallback when a browser omits that metadata.

The voice framing state machine consumes the on-device landmark stream, but landmarks never enter the speech request. Corrections must remain stable before they are committed, unresolved cues repeat slowly, and speech is suppressed during swings, for four seconds after recent movement, and during calibration, pause, demo, hidden-page, and ended-session states. Visual text and direction controls remain the baseline whether speech is enabled or not.

The initial app bundle stays separate from the Worker and the optional Three.js movement view. Clip playback pauses through extraction and inference for each sampled frame, keeps at most one transferable frame in flight and no frame queue, and then resumes at up to 4× on GPU or 2× on CPU. Native `ended` handling drains the final in-flight frame before settling. Decoder, bitmap-extraction, Worker-inference, and whole-run timeouts report distinct failures. Inference prefers GPU and retries on CPU with a fresh MediaPipe module loader if GPU initialization fails. Frame responses are correlated to an exact Worker, job, and frame; cancelling or timing out an already-transferred frame replaces only that Worker and keeps new analysis disabled until the replacement reports ready.

MediaPipe `0.10.35`, its SIMD WASM runtime, and the full float16 pose model are pinned. `npm ci` copies the runtime from the locked package, downloads the revisioned model, verifies its SHA-256 digest, and stages it with the brand fonts as same-origin production assets. Runtime camera and clip sessions therefore do not depend on Google Fonts, jsDelivr, or Google Storage.

## Optional AI voice framing

The two selectable profiles are app-defined delivery styles over OpenAI built-in voices:

| Profile | Built-in voice | Intended presentation |
| --- | --- | --- |
| Command · British male | `cedar` | Calm, crisp, lower-register British command delivery without shouting or aggression |
| Command · British female | `marin` | Calm, crisp British command delivery with a feminine presentation, without shouting or aggression |

Speech is clearly disclosed as AI-generated. The profiles do not reproduce a named person and are not cloned voices or OpenAI Custom Voices. Genuine [OpenAI Custom Voices](https://developers.openai.com/api/docs/guides/text-to-speech#custom-voices) are a separate feature limited to eligible customers and require two recordings from the same actor: an approved consent recording and a matching voice sample.

The user must opt in before any Realtime connection is created. The browser adds one receive-only audio transceiver—not a microphone track or data channel—and posts its SDP offer to the same-origin `POST /api/realtime-session?profile=...` route. The trusted server validates a tightly bounded audio-only offer, keeps `OPENAI_API_KEY` out of the browser, attaches a privacy-preserving safety identifier, and uses OpenAI's [unified WebRTC interface](https://developers.openai.com/api/docs/guides/realtime-webrtc) to create a [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) session.

The server returns the SDP answer with a short-lived, HMAC-signed capability bound to the OpenAI call, selected profile, pseudonymous client, and expiry. For speech, the browser can send only an exact cue ID—not text, instructions, model settings, or Realtime events—to `POST /api/realtime-cue`. The server validates the capability and maps that ID to the fixed phrase before sending server-owned `cancel`, `clear`, and `response.create` events over OpenAI's documented [sideband control channel](https://developers.openai.com/api/docs/guides/realtime-server-controls). Completion is accepted only after the matching response and WebRTC output buffer have drained. No microphone audio, camera video, clip, frame, image, or pose landmark is attached or sent.

Changing profile closes the current peer connection and creates a fresh session. This is intentional because a Realtime session's [voice cannot be changed after it has emitted audio](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options). If session creation, WebRTC, rate limiting, or output fails, visual guidance stays active and the client can fall back to a browser-reported local English system voice. Device fallback availability, accent, presentation, timing, and underlying OS/browser privacy behaviour may vary; it is not represented as `cedar` or `marin`.

## Coaching and claims boundary

The current analyzer can report pose visibility, swing phase, completed rep count, hinge/knee relationships, shoulder lift, torso/head stack, and camera quality when evidence is sufficient.

Ordinary monocular pose landmarks cannot measure pain, breathing, bracing, muscle activation, spinal load, tissue capacity, kettlebell force, or injury risk. The body, region, skeleton, trail, and optional 3D layers are illustrative views—not anatomical or clinical measurements.

Stop for pain, dizziness, unusual breathlessness, or loss of bell control. New lifters benefit from in-person instruction.

## Local development

Requirements:

- Node.js 24
- npm 11
- A modern browser with module Workers, WebAssembly, `ImageBitmap`, camera APIs, and WebRTC; local speech synthesis is an optional failure fallback
- An OpenAI project API key only if the opt-in AI voice path is being tested

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Edit `.env.local` and set `OPENAI_API_KEY` to a server-side OpenAI project key. Never prefix it with `VITE_`, print it into client code, or commit the file. `KB_FORM_ALLOWED_ORIGINS` may contain comma-separated additional exact origins; the request's own same origin is accepted automatically. `KB_FORM_SAFETY_ID_SECRET` is an optional independent HMAC secret for pseudonymous Realtime safety identifiers and signed session capabilities. The app and all visual coaching continue to work when the key is absent; AI speech then degrades to device speech when available, otherwise visual cues only.

Open the printed `127.0.0.1` URL. For live analysis, keep the recommended **Room view** to request an environment-facing camera when supported or choose **Selfie view**, optionally enable **Voice framing coach**, and select **Start camera**. Once permission is granted, choose among the cameras the browser exposes. Use **Preview coaching** for the camera-free demonstration, or **Analyze a clip** and then **Choose a video** for the local clip workflow. Clip support depends on the browser's native decoders.

### Quality commands

```bash
npm run check          # lint + typecheck + coverage + verified production build
npm test               # deterministic unit and component tests
npm run test:watch     # local test loop
npm run audit:prod     # production dependency audit
npm run preview        # serve the production build locally
```

`npm run build:verify` enforces required deployment files, the model checksum, same-origin runtime policy, self-hosted font budget, security configuration, SPA fallback, source-map policy, initial/chunk budgets, and a total-output budget.

`npm run preview` serves the static production output and is useful for visual/clip smoke tests; use `npm run dev` or a Vercel Preview deployment when exercising the same-origin Realtime session and cue routes.

## DevOps

- GitHub Actions runs the full quality gate on pull requests and `master`.
- CodeQL scans JavaScript and TypeScript on pull requests, pushes, a weekly schedule, and manual runs.
- Dependabot groups weekly npm and GitHub Actions updates.
- CI uploads the verified production build and coverage report for seven days.
- Vercel serves the production app and same-origin Realtime session/cue routes over HTTPS with restrictive CSP, camera-only permissions, frame protection, immutable hashed/runtime asset caching, and SPA deep-link rewrites. The microphone Permissions Policy remains disabled.
- Netlify/Cloudflare-compatible `_headers` and `_redirects` files preserve the static-host defaults. AI voice on another host still requires an equivalent secure same-origin session function and scoped server key; without it, the app uses device speech when available or remains visual-only.

### Realtime voice deployment

1. Create separate least-privilege [OpenAI project API keys](https://platform.openai.com/settings/organization/api-keys) for Preview and Production. In Vercel **Project → Settings → Environment Variables**, add `OPENAI_API_KEY` to **Preview** and **Production** independently, add an independent `KB_FORM_SAFETY_ID_SECRET` to each, and redeploy both environments. Do not expose either value through a `VITE_` variable. See [Vercel environment variables](https://vercel.com/docs/environment-variables) and [OpenAI's server-side key pattern](https://developers.openai.com/api/docs/guides/realtime-webrtc#creating-a-session-via-the-unified-interface).
2. In Vercel Firewall, publish fixed-window IP rules for both trusted boundaries: `/api/realtime-session` allows **12 requests per 600 seconds** and `/api/realtime-cue` allows **120 requests per 600 seconds**, returning the default `429` after either limit. Verify both against Preview and Production. These rules are dashboard-managed deployment state, not repository configuration. The session rule is live; Vercel rejected the cue rule on the current project plan, so that durable cue quota remains an explicit deployment blocker until rate limiting is enabled or an equivalent shared control is added. See [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
3. Keep the application limiters as defence in depth: one server process allows at most 6 session attempts and 24 cue commands per minute per pseudonymous client, with 2 concurrent requests of either kind. They are deliberately best-effort because separate serverless instances do not share memory; they do not replace the firewall rules or an OpenAI project usage budget.

### Voice release runbook

- Run `npm run check`, `npm run test:e2e`, and the explicit live smoke test. Verify both profiles, server-owned fixed-message mapping, origin and `Sec-Fetch-Site` rejection, audio-only SDP, signed capability tamper/expiry/client binding, cue body/event/aggregate bounds, response-ID-correlated buffer drain, missing-key behaviour, timeouts, rate limits, and cleanup.
- For a deployment-protected Preview, supply `KB_FORM_BASE_URL` and `KB_FORM_PROTECTION_BYPASS` only to `npm run test:realtime:live`. The smoke helper accepts only this project's exact HTTPS Vercel Preview hostname, makes one bootstrap request without following redirects, and requires Vercel's root-path, Secure, HttpOnly, same-site bypass cookie to be scoped to that exact host. It never installs the bypass token as a browser-wide header; never reuse the credential against an arbitrary URL or print it in logs.
- In local development, Vercel Preview, and Production, opt in to each profile and hear the disclosed fixed cue. Confirm that switching profiles closes the old connection and starts a fresh session.
- Inspect browser permissions and network activity: camera capture must still request `audio: false`; no microphone permission, outgoing media track, or browser Realtime data channel may exist; no frame, clip, image, or landmark may leave the browser. The expected opt-in transfer is audio-only session negotiation, signed capability, allowlisted cue IDs to the same-origin server, fixed text from server to OpenAI, and returned AI audio.
- Exercise key-absent, offline, denied, `429`, upstream-timeout, peer, sideband, invalid/expired capability, hidden-page, pause, disable, and ended-session paths. Active output must pause locally and cancel/clear server-side; the peer must close on failure, hidden page, disable, end, or unmount; visual guidance must remain. Device speech may be unavailable or sound different.
- Verify each published firewall rule with a controlled source and confirm recovery after its window. Do not run load tests against an unrelated user's IP or a shared production source; do not mark the cue boundary complete while its durable rule remains unavailable.
- Review OpenAI usage and Vercel firewall logs for unexpected volume without logging API keys, SDP bodies, cue contents, IP addresses, frames, or landmarks in application logs.

For routine key rotation, create a replacement key, update and redeploy Preview, run the voice smoke test, then update and redeploy Production and smoke-test again before revoking the old key. Rotate `.env.local` separately. If a key is suspected exposed, revoke it immediately; visual coaching and device fallback provide the safe degraded path while a replacement is deployed. Rotate `KB_FORM_SAFETY_ID_SECRET` if it is exposed, understanding that this deliberately changes the pseudonymous safety identifiers.

## Validation status

The deterministic Vitest suite currently contains 392 tests covering calibration, tracking loss, ordered rep phases, abstention, malformed input, feedback/risk behavior, setup UI, full-frame room/selfie constraints, permission-gated enumeration, exact camera switching and cancellation-safe fallback, conditional and user-correctable mirroring, fail-open optical capability probing, fixed voice profiles and message validation, Vercel Fetch-route adapters, canonical audio-only SDP negotiation, bounded upstream streaming, signed capabilities, trusted sideband event construction and order-independent lifecycle bounds, client cancellation/draining/cleanup, exact-origin Preview-protection bootstrapping, private device-speech fallback, complete shoulder/hip/knee framing gates, framing direction/aspect/edge gates, recent-motion suppression, debounce/repetition/cancellation, exact end-of-file completion, false endpoint jumps in both frame schedulers, in-flight final-frame draining, phase-specific watchdogs, native media errors, damaged-media recovery, immediate retry, and credential-independent rejection of unsigned cue requests. Four additional Playwright tests cover responsive profile/disclosure rendering, opt-in-only device fallback with no Realtime request, and same-origin session/cue route rejection boundaries.

Recorded release-baseline transport QA in GPU-backed Chrome for Testing 151 includes H.264 MP4, VP8 WebM, VP9 WebM, portrait VFR H.264, six exact-duration 4.2-second EOF runs, a public VP8 tail window, a deliberately truncated fast-start MP4, and a CC0 no-person control. Every valid clip completed without a decode-stall error; the damaged file failed promptly and the next valid clip succeeded without a reload. Installed Chrome 150 corroborated the same codec and recovery paths. See [Video compatibility and public-fixture QA](docs/VIDEO_COMPATIBILITY.md) for the measurements, fixture recipe, software-only headless limitation, and evidence boundary.

The remaining release gates require real evidence: physical front/rear/ultra-wide camera sessions, spoken-cue timing and screen-reader testing on target devices, held-out athlete videos, qualified coach labels, Safari/Firefox/iOS/Android and HEVC/MOV coverage, target-device performance/thermal testing, trim and crop accessibility testing, privacy-egress inspection, and motion-capture comparison where kinematic claims require it.

## Documentation

- [Technical audit](docs/AUDIT_REPORT.md)
- [Evidence and safety specification](docs/EVIDENCE_AND_SAFETY.md)
- [Video compatibility and public-fixture QA](docs/VIDEO_COMPATIBILITY.md)
- [Technical roadmap](docs/TECHNICAL_ROADMAP.md)
- [Coaching model](docs/coach-model.md)
- [Generated and source assets](docs/assets.md)

## License

No open-source license has been granted yet. The repository is publicly readable, but reuse rights remain reserved until a license is added.
