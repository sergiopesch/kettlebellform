# Product Assets

## Product screenshots

Paths:

- `docs/screenshots/kb-form-preview-desktop.jpg`
- `docs/screenshots/kb-form-camera-setup.jpg`
- `docs/screenshots/kb-form-camera-setup-mobile.jpg`
- `docs/screenshots/kb-form-clip-upload.jpg`
- `docs/screenshots/kb-form-clip-editor.jpg`
- `docs/screenshots/kb-form-clip-editor-mobile.jpg`
- `docs/screenshots/kb-form-clip-analyzing.jpg`
- `docs/screenshots/kb-form-clip-result.jpg`
- `docs/screenshots/kb-form-clip-result-mobile.jpg`

These are browser captures of the implemented setup, camera-free preview, local clip editor, on-device analysis, and fail-closed result states at desktop and mobile widths. The setup and preview captures were refreshed on 3 August 2026 after the compact voice-control release; the clip workflow set was refreshed on 2 August 2026 for Arena Red. Together they show the current full-frame Room/Selfie selection, visible selected-state checks, opt-in voice control, local crop editor, branded analysis loader, and fail-closed result. The README uses the representative desktop views. The obsolete generated anatomy/depth hero was removed because it no longer represented the shipped product or its evidence boundary.

## Favicon

Path: `public/favicon.svg`

The favicon is a deterministic repository asset designed to stay legible at browser-icon sizes.

## Coaching preview

Paths:

- `public/demo-swing.png` — camera-free source frame and subdued setup reference.
- `public/demo-swing-overlay.png` — the same frame with an illustrative pose-tracking overlay.

Both assets were produced with the built-in ImageGen tool and are workspace-bound. Prompt summary: preserve a realistic side-profile athlete performing a two-hand shoulder-height kettlebell swing in a restrained dark gym; for the overlay variant, add only a thin Arena Red landmark skeleton and subtle dotted bell arc, with no text, scores, UI chrome, extra people, or extra equipment.

The overlay is labelled as an interactive sample in the product. It is not presented as a real measurement. Live-camera landmarks remain code-driven.

## British Maritime Command voice pack

Paths:

- `src/assets/coach-voices/v2/male-command/` — Harbour profile, 11 MP3 files.
- `src/assets/coach-voices/v2/female-command/` — Crown profile, 11 MP3 files.
- `src/data/coachVoiceManifest.v2.json` — candidate identity, disclosure, pinned local/upstream 1.7B model provenance, mastering metadata, transcript, byte length, duration, and SHA-256 for every file.
- `src/lib/coachVoiceAssets.ts` — statically enumerated Vite asset URLs and the exhaustive typed profile/message map; creating the map performs no network fetch.
- `scripts/master-coach-voice-pack.mjs` — deterministic mastering and manifest generation from an explicit private input directory.
- `scripts/verify-coach-voice-pack.mjs` — source-pack media, size, loudness, provenance, and integrity checks.
- `scripts/generate-coach-voice-references.py` — fail-closed future reference workflow that seals exact prompts, seeds, settings, authenticated runtime provenance, a staged-model content-tree attestation, candidate paths, and script hash before generation, then re-hashes the cached model before inference.

The committed `maritime-command-v2` candidate contains 22 distinct 24 kHz mono MP3 files—11 exact messages for each of two original, non-impersonating Qwen-designed British leadership voices—and totals 323,166 bytes. Male/female phrase totals are 19,300/19,133 ms (0.87% delta), with a 0.036 LU mean-loudness gap. The browser fetches only explicit Vite-hashed same-origin assets, streams each under a fixed 15-second deadline and exact manifest-sized ceiling, and verifies `audio/mpeg`, byte length, and SHA-256 before decoding with Web Audio. There is no runtime speech model, provider call, server function, credential, microphone, or arbitrary asset URL. Accent, energy, naturalness, and intelligibility remain pending blind human listening approval.

VoiceDesign references, raw WAV generations, reusable clone prompts or embeddings, tokens, and credentials belong only in the gitignored `.voice-private/` release archive. They are not application assets and must never be committed or deployed. The exact historical v2 VoiceDesign instruction was not persisted. The new reference generator prevents that gap for future rounds by requiring a private, SHA-256-bound receipt before inference; it does not retroactively reconstruct the v2 prompt or replace human listening. Pinned local/upstream model provenance, the semantic shared brief, mastering constraints, fallback behaviour, and human listening sign-off are documented in [British Maritime Command voice pack](./VOICE_PACK.md).

## Generated runtime assets

`npm ci` creates the ignored `public/vendor/mediapipe/0.10.35/` and `public/models/` directories. The WASM loader and binary are copied from the exact locked npm dependency. The revisioned pose model is downloaded during installation and accepted only when it is exactly 9,398,198 bytes and matches the SHA-256 digest recorded in `scripts/prepare-model-assets.mjs`. The streamed response has a 60-second deadline and the same 9,398,198-byte declared/actual ceiling. Cleanup inspects at most 512 directory entries and removes at most 16 exact-pattern, regular, single-link temporary files per run, only after they are 24 hours old and their recorded owner PID is definitively dead.

These generated runtime files are included in the production build and served from the application origin; they are intentionally not committed as duplicate binary artifacts.
