# British Maritime Command voice pack

## Candidate summary

KB FORM voice-pack candidate `maritime-command-v2` contains two original fictional AI characters designed as a matched leadership pair:

- **Harbour** — a clean mid-low British baritone with brisk, disciplined warmth and forward drive.
- **Crown** — a clean mid-low British mezzo/alto with the same pace, attack, confidence, warmth, and forward drive.

Neither character is presented as a recording of a human coach, an imitation of a named person, or a member of a real military unit. “Maritime Command” is a fictional product description. The compact disclosure, “Original AI-generated voices—not human recordings; no military affiliation,” must remain visible wherever the profile is selected; the fuller provenance stays available in settings and this document.

The runtime pack contains exactly 22 files: every combination of two profiles and the eleven exact messages in `src/lib/coachVoicePolicy.ts`. The published files total 323,166 bytes. Across the complete phrase set, Harbour totals 19,300 ms and Crown totals 19,133 ms, a 0.87% duration delta; their mean integrated-loudness gap is 0.036 LU. These measurements establish pair-level timing and level parity, not British authenticity or leadership quality. The pack remains a **candidate pending blind human listening approval**.

## Model provenance

| Stage | Model or runtime | Revision | Terms |
| --- | --- | --- | --- |
| Identity design, upstream | [`Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) | `5ecdb67327fd37bb2e042aab12ff7391903235d3` | Apache-2.0 |
| Identity design, local Apple-Silicon inference | `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16` through `mlx-audio` | `7d3824abff87e49756bb0f83fb5411de75d160c4` | Converted implementation; upstream model remains Apache-2.0 |
| Consistent rendering, upstream | [`Qwen/Qwen3-TTS-12Hz-1.7B-Base`](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) | `fd4b254389122332181a7c3db7f27e918eec64e3` | Apache-2.0 |
| Consistent rendering, local Apple-Silicon inference | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16` through `mlx-audio` | `a6eb4f68e4b056f1215157bb696209bc82a6db48` | Converted implementation; upstream model remains Apache-2.0 |
| Mastering | FFmpeg `loudnorm`, fades, silence trim, limiter, `libmp3lame` | local release toolchain | See the installed FFmpeg licence/build |

Both identity references and all 22 production phrases were generated locally on an Apple M3 with 24 GB unified memory using the pinned MLX VoiceDesign and Base conversions above. The public Hugging Face Space could not generate this release because its ZeroGPU quota was exhausted; it was not a generation source. Public quota and cold-start behaviour therefore cannot affect the application or release build.

The public Qwen demo is an audition surface, not a production dependency. No Hugging Face endpoint is called by the app, CI, Vercel, or a user session.

## Identity brief and references

Both identities used the same semantic, non-identifying British leadership brief: contemporary Standard Southern British English with modern non-rhotic pronunciation, crisp endings, and natural stress-timed rhythm; calm urgency, compact phrasing, clear stress on action words, decisive falling finishes, a full non-breathy tone, disciplined warmth, and restrained encouragement. The design explicitly avoided shouting, growling, bullying, parody, vintage-posh theatre, and imitation of a named person. Harbour's only identity delta was a clean mid-low baritone without growl or boom. Crown's was a clean mid-low mezzo/alto without breathiness, shrillness, or cheerleader affect, while retaining the same pace, attack, confidence, and warmth.

The exact historical v2 VoiceDesign instruction was not persisted. That provenance limitation cannot be reconstructed: this document records its reviewed semantics, but cannot claim a byte-for-byte v2 prompt. The repository now prevents the same gap prospectively. `scripts/generate-coach-voice-references.py` refuses to generate a future candidate until it has written a private, immutable, SHA-256-bound plan containing the exact shared and profile instructions, model revisions and staged model-content attestation, complete authenticated runtime-manifest digest and approved uv/CPython executable and tree provenance, seed and sampling settings, candidate identifiers and paths, reference transcript, output limits, script hash, and explicit human-selection gate.

Here, “authenticated” means revalidated against the approved committed manifests, exact revisions, authenticated archive digests, and locally recomputed file/tree SHA-256 values. The plan and receipt are tamper-detecting but are not digitally signed and do not establish an independent publisher identity; repository access controls and the required human review remain part of the trust boundary.

Both references used the same exact transcript:

> After the last set, stand tall; keep your shoulders back, breathe steadily, and drive forward with purpose. Good—hold that standard. You are ready.

Both references were created synthetically. No human voice was uploaded or cloned. A release reviewer must nevertheless reject a candidate that sounds confusingly similar to an identifiable person.

The brief uses SSBE as a target pronunciation rather than treating one accent as universally “British”; published work describes SSBE as categorically non-rhotic in non-prevocalic contexts ([Blaxter et al., 2019](https://doi.org/10.1017/S0954394519000048)). Cross-gender research associates charismatic speech with acoustic pitch and intensity strategies, but also finds language-, culture-, and gender-specific variation, so the app uses matched timing and loudness only as engineering checks—not as a charisma score ([Signorello et al., 2020](https://pubmed.ncbi.nlm.nih.gov/31196689/)). “Maritime Command” is a fictional product identity; the [Royal Navy's published values](https://www.royalnavy.mod.uk/organisation/our-people/our-values) informed the vocabulary of discipline and commitment, not a claim of affiliation, endorsement, or authentic service speech.

The candidate reference WAV files and raw generated WAV clips live in the local, gitignored `.voice-private/` release archive. Never commit or deploy reference audio, raw masters, a Qwen voice-clone prompt, speaker embeddings, Hugging Face tokens, or model credentials. Only the mastered files under `src/assets/coach-voices/v2/` are public.

## Reproducible future identity design

The future-reference workflow is deliberately staged and receipt-gated:

1. `stage-reference-model` downloads only the exact public revision, inventories and hashes its resolved content tree, and writes an owner-only private attestation.
2. `prepare` creates the run directory and durably records the complete immutable plan, including that attestation's document and content-tree digests, before MLX, Hugging Face, or a model is imported or loaded.
3. A reviewer inspects that receipt, then `generate` validates the plan, exact toolchain provenance, private attestation, output location, and any existing output hashes. It re-hashes the cached model tree before loading the model, so mutation after staging or preparation fails closed.
4. Every candidate WAV is written without overwriting an existing file and immediately recorded with its seed, media facts, SHA-256, and timestamp. `--resume` accepts only a prepared, generating, or failed receipt and still refuses unrecorded or symlinked files.
5. `verify` rechecks the immutable plan and every recorded output. Completion remains `generated-awaiting-human-listening`; the tool has no promotion path into `src/assets`.

The lightweight CI-safe safeguard exercises sealing, verification, overwrite refusal, model-cache and plan tamper rejection, receipt/output symlink rejection, and `.voice-private` path confinement with temporary fixtures and without loading a model or creating audio:

```bash
npm run voice:references:check
```

For a real future round, stage the authenticated runtime and exact public
VoiceDesign model revision before supplying a private run path:

```bash
python3 scripts/run-coach-voice-generation.py stage-runtime
python3 scripts/run-coach-voice-generation.py stage-reference-model
python3 scripts/run-coach-voice-generation.py prepare-references \
  .voice-private/reference-runs/maritime-command-v3-round-1
```

After reviewing the prepared receipt, generate and verify offline:

```bash
python3 scripts/run-coach-voice-generation.py generate-references \
  .voice-private/reference-runs/maritime-command-v3-round-1
python3 scripts/run-coach-voice-generation.py verify-references \
  .voice-private/reference-runs/maritime-command-v3-round-1
```

The immutable plan binds the complete hash-locked 41-distribution graph, not
only direct package versions. It also binds the complete authenticated runtime
manifest, including the approved uv binary and CPython executable/tree hashes.
The wrapper serializes every release command with a non-blocking advisory lock
that is released automatically when its process exits, and rebuilds the
virtualenv from approved wheels before every command. Public model staging is a
separate online action that accepts no private path; generation requires the exact cached revision and
sets Hugging Face and Transformers offline. Production reference commands reject
paths outside this repository's real `.voice-private` root or paths that escape
through symlinks. Generation remains a local release operation and is never part
of install, CI, Vercel, or an application session.

## Mastering contract

Every committed clip must satisfy all of the following:

- MP3 audio only, with one audio stream and no video, cover-art, subtitle, or data stream.
- 24 kHz, mono, 64 kbps.
- Duration from 350 ms through 6.5 seconds.
- Integrated loudness from −17 through −15 LUFS.
- True peak no higher than −1 dBTP.
- No more than 96 KiB per clip and 2 MiB for the complete pack.
- Metadata stripped apart from unavoidable encoder/container fields.
- Exact transcript from the allowlist, with no preamble, tail leakage, added coaching, or reference-text residue.
- Distinct SHA-256 for every file, including the same phrase across profiles.

`scripts/master-coach-voice-pack.mjs` performs deterministic trimming, short edge fades, two-pass loudness normalization, bounded corrective limiting for unusually dynamic short lines, mono resampling, MP3 encoding, metadata stripping, and manifest generation.

To regenerate the production WAVs, first stage the authenticated release runtime
and exact public model snapshot. These are the only network-enabled steps, and
neither receives a private reference path:

```bash
python3 scripts/run-coach-voice-generation.py stage-runtime
python3 scripts/run-coach-voice-generation.py stage-model
```

Then verify and generate offline from the selected private references:

```bash
python3 scripts/run-coach-voice-generation.py check-runtime
python3 scripts/run-coach-voice-generation.py generate \
  .voice-private/references-v2 \
  .voice-private/raw-v2
```

The wrapper authenticates the exact `uv` executable, exact Python 3.12.13
installation (identified account-home-relatively in the manifest, without a
developer username), and `requirements/voice-generation.lock` before
synchronizing the complete 41-package graph. `stage-runtime` accepts only wheels whose real
resolver-produced SHA-256 appears in that lock; source distributions, build
hooks, local sources, user packages, ambient Python configuration, and implicit
Python downloads are rejected. `stage-model` then downloads only model revision
`a6eb4f68e4b056f1215157bb696209bc82a6db48`. Runtime and model staging are
deliberate release operations, never application, install, CI, or Vercel steps.
It creates `.voice-private` with owner-only permissions, repairs an existing
group/world-readable root to mode `0700`, and rejects symlinked roots or any
production input/output path that resolves outside that repository-local root.
The managed-Python digest covers every immutable file and symlink. Generated
`__pycache__` content is excluded only because the wrapper rejects symlinked
caches, removes those cache directories plus any standalone `.pyc`/`.pyo`
before `uv` can inspect the interpreter, and runs every approved Python process
with bytecode writes disabled and lookup redirected to a freshly emptied
owner-only cache below `.voice-private`.

For audit purposes, after authenticating the toolchain manifest and safely
removing only the validated generated virtualenv, the wrapper's offline path is
equivalent to this constrained sequence (use the wrapper, which also performs
the containment, binary, and installation-tree digest checks). In this
schematic, `$VERIFIED_PYTHON` is the absolute interpreter path the wrapper has
already derived from the account database and authenticated against the
manifest:

```bash
uv --offline --no-python-downloads --no-config venv \
  --no-project --python "$VERIFIED_PYTHON" \
  .voice-private/voice-runtime
uv --offline --no-python-downloads --no-config pip sync \
  --python .voice-private/voice-runtime/bin/python \
  --require-hashes --only-binary=:all: --strict --no-sources \
  requirements/voice-generation.lock
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .voice-private/voice-runtime/bin/python -I \
  scripts/generate-coach-voice-raw.py \
  .voice-private/references-v2 .voice-private/raw-v2
```

Generation has no package or model fallback: if the authenticated wheels,
installed distribution inventory, or exact model snapshot are absent, it stops
before reading a private reference. The generator records the lock digest, full
package inventory, exact model revisions, sampling settings, reference hashes,
per-cue seeds, durations, and output hashes in the private generation receipt.
`--override PROFILE/CUE=SEED` regenerates a deliberately selected alternative
without changing unrelated clips.

When intentionally updating a direct production dependency, edit
`requirements/voice-generation.in`, inspect the resolver result, update the
manifest and generator lock digest, and regenerate the committed lock with:

```bash
MACOSX_DEPLOYMENT_TARGET=14.0 \
uv --no-python-downloads --no-config pip compile \
  requirements/voice-generation.in --python 3.12.13 \
  --python-platform aarch64-apple-darwin \
  --only-binary=:all: --generate-hashes --no-sources \
  --no-emit-package pip --no-emit-package setuptools \
  --output-file requirements/voice-generation.lock
python3 scripts/check-coach-voice-runtime.py
python3 scripts/check-coach-voice-runtime.py --local-toolchain
```

The first check is portable and suitable for the normal project/CI check path;
it verifies lock closure, authentic hashes, wrapper ordering, delayed imports,
and documentation without requiring the release Mac. The second additionally
authenticates the manifest-bound `uv` and CPython files on the release Mac.

To rebuild from the private raw archive:

```bash
npm run voice:master -- \
  .voice-private/raw-v2 \
  src/assets/coach-voices/v2 \
  src/data/coachVoiceManifest.v2.json
```

The command intentionally requires an explicit private input directory. Voice generation is not part of `npm install`, CI, or a Vercel build.

## Automated qualification

Run:

```bash
npm run test:e2e:install # once; append -- --with-deps on a clean Linux host
npm run verify:all
```

`verify:all` runs the authenticated voice-runtime/reference checks, `voice:verify`, lint, type-checking, coverage, a verified production build, Chromium/Firefox/WebKit regression projects, and the complete dependency audit.

`voice:verify` uses FFprobe and FFmpeg to verify:

- the exact 2 × 11 file set with no extra asset;
- manifest phrase, path, byte length, and SHA-256 agreement;
- unique hashes;
- codec, stream count, sample rate, channels, duration, and file-size bounds. The manifest duration remains deterministic; FFprobe may differ by up to three MPEG-2 Layer III frames (72 ms at 24 kHz) because FFmpeg releases report encoder delay/padding differently, so the verifier accepts only that bounded probe delta while exact bytes and SHA-256 remain mandatory;
- integrated loudness and true peak;
- model/licence/non-impersonation provenance fields;
- per-cue duration, active-duration, pause-share, internal-pause-count, internal-pause-total, and loudness parity across the two profiles;
- complete-profile duration, active-duration, pause-share, and mean-loudness parity.

The v2 verifier reports 19,300 ms for Harbour and 19,133 ms for Crown (0.87% delta) and a 0.036 LU mean-loudness gap. An independent release pass transcribed every mastered clip with `faster-whisper` 1.2.1 and the pinned `small.en` snapshot `d1d751a5f8271d482d14ca55d9e2deeebbae577f`: all 22 normalized word sequences matched the manifest, including the uncontracted “you are” in both `ready` clips. Automation cannot certify accent, naturalness, confidence, or emotional effect. ASR is supporting evidence only; exact wording remains a human release check.

`build:verify` separately compares all 22 source hashes with the content-hashed MP3 files emitted by Vite, enforces the 2 MiB pack budget, rejects retired Realtime routes and runtime provider origins, and confirms the deployment remains static.

## Runtime security and privacy

The browser does not construct an asset URL from user input. `src/lib/coachVoiceAssets.ts` statically enumerates every file with a literal `new URL(..., import.meta.url)` and exports an exhaustive typed profile/message map. Creating that map performs no request; Vite emits hashed production assets, and the client fetches only the selected profile after opt-in.

After opt-in, `src/lib/coachVoicePackClient.ts`:

1. synchronously starts one owned `AudioContext` resume from the click and waits for it to succeed before any native decode;
2. streams the selected profile's eleven Vite-hashed, same-origin URLs in parallel under a fixed 15-second per-asset deadline;
3. limits each response to its exact manifest byte length and rejects declared or actual overflow, short bodies, and stalled streams;
4. requires HTTP success, exact `audio/mpeg` MIME, and SHA-256 before decoding;
5. serializes `decodeAudioData()` and retains queue ownership until the underlying decode settles, so cancellation or a profile retry cannot create overlapping native decoder jobs;
6. applies a non-weakenable eight-second whole-activation deadline to resume, fetch, digest, and decode, then permanently retires that client for the page and starts context closure before using the labelled fallback; no new branded `AudioContext` is created until reload, even if native close never settles;
7. caches decoded `AudioBuffer` objects for the page lifetime;
8. plays only exact `CoachVoiceMessage` objects;
9. owns one source at a time, fades an interrupted source before disconnecting it, and invalidates stale activation/playback generations;
10. aborts and cancels unfinished asset requests and releases their readers when activation is superseded, disabled, hidden, timed out, failed, or ended;
11. suspends the audio context while inactive and closes it on unmount.

The automated Chromium and WebKit projects exercise their native Web Audio decoders. The verified-pack scenario in headless Firefox on the Linux CI runner has no reliable audio sink, so that scenario installs a deterministic in-page Web Audio shim while continuing to fetch, size-limit, hash, and state-test the real committed MP3s; the other Firefox scenarios retain native browser APIs. Firefox hardware playback and cue timing therefore remain explicit target-device release checks rather than implied CI coverage.

The production voice path contains no OpenAI or Hugging Face credential, request, WebRTC peer, WebSocket, microphone track, data channel, server function, free-form text surface, or arbitrary URL fetch.

## Human release sign-off

Automation cannot decide whether a character is authentically British, sufficiently distinct, appropriately authoritative, or comfortable through a phone speaker. Before publishing a new pack, two people should listen blindly to every clip and record acceptance for:

- exact wording;
- stable identity across all phrases;
- British accent and natural non-rhotic pronunciation;
- authority without aggression, intimidation, parody, or shouting;
- intelligibility at low phone volume and moderate room noise;
- no clipping, clicks, metallic tails, reference leakage, or excessive silence;
- clean interruption and profile switching on Chrome, Firefox, desktop Safari, Android Chrome, and iPhone Safari;
- coexistence with VoiceOver and TalkBack.

If sign-off fails, replace the complete affected profile rather than mixing identities from unrelated VoiceDesign runs. Increment the pack version whenever any audio byte or identity changes.
