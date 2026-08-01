# Visual Assets

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

These are browser captures of the implemented setup, camera-free preview, local clip editor, on-device analysis, and fail-closed result states at desktop and mobile widths. The README uses the representative desktop views. The obsolete generated anatomy/depth hero was removed because it no longer represented the shipped product or its evidence boundary.

## Favicon

Path: `public/favicon.svg`

The favicon is a deterministic repository asset designed to stay legible at browser-icon sizes.

## Coaching preview

Paths:

- `public/demo-swing.png` — camera-free source frame and subdued setup reference.
- `public/demo-swing-overlay.png` — the same frame with an illustrative pose-tracking overlay.

Both assets were produced with the built-in ImageGen tool and are workspace-bound. Prompt summary: preserve a realistic side-profile athlete performing a two-hand shoulder-height kettlebell swing in a restrained dark gym; for the overlay variant, add only a thin mineral-lime landmark skeleton and subtle dotted bell arc, with no text, scores, UI chrome, extra people, or extra equipment.

The overlay is labelled as an interactive sample in the product. It is not presented as a real measurement. Live-camera landmarks remain code-driven.

## Generated runtime assets

`npm ci` creates the ignored `public/vendor/mediapipe/0.10.35/` and `public/models/` directories. The WASM loader and binary are copied from the exact locked npm dependency. The revisioned pose model is downloaded during installation and accepted only when it matches the SHA-256 digest recorded in `scripts/prepare-model-assets.mjs`.

These generated runtime files are included in the production build and served from the application origin; they are intentionally not committed as duplicate binary artifacts.
