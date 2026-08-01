# Video compatibility and public-fixture QA

This document records repeatable transport testing for KB FORM's local clip workflow. A transport pass means the browser loaded, sought, cropped, sampled, and completed the selected window without hanging or misclassifying clean end-of-file. It does not mean the movement passed the coaching evidence gates.

## Current compatibility statement

KB FORM accepts MP4, WebM, and MOV container hints, then lets the browser's native decoder decide whether the enclosed codec is supported. Tested desktop Chrome paths include H.264/AAC MP4, VP8 WebM, video-only VP9 WebM, portrait H.264, and variable-frame-rate H.264. Container names alone do not guarantee codec support, especially for MOV/HEVC and mobile camera variants.

All analysis remains in the browser. The complete source stays available for preview. Only presented frames within the selected 4–10 second range are cropped, downscaled to at most 640 pixels on the longest edge, and submitted to inference; the browser may internally decode earlier keyframes required by the selected media. There is one transferable `ImageBitmap` in flight and no frame queue.

The player treats the media element's native `ended` event as the canonical EOF signal. If EOF arrives while frame extraction or Worker inference is active, that exact frame is drained before success. Independent watchdogs distinguish decoder starvation (6 seconds), slow frame extraction (10 seconds), stalled Worker inference (15 seconds), and the 30-second whole-run deadline. The inference watchdog is re-armed after each bitmap transfer, so cold GPU startup is not incorrectly charged to extraction.

## Verified regression matrix

Primary environment: local production bundle, GPU-backed headful Chrome for Testing 151 on macOS, tested 2026-08-01. Default selected windows ranged from 4.2 to 9.9 seconds, and metadata became available in 27–266 ms.

| Scenario | Media characteristics | Attempts | Outcome |
| --- | --- | ---: | --- |
| Exact EOF regression | H.264/yuv420p MP4, 4.204 s, selection 0–4.204 s | 6 | 6/6 completed in 1.679–1.899 s; processed-frame counts were 28, 28, 29, 32, 29, and 28 |
| Equivalent swing window | H.264/AAC MP4, 9.810 s | 1 | Completed in 10.297 s with 118 processed frames |
| Equivalent swing window | VP8 WebM, 9.810 s | 1 | Completed in 5.454 s with 105 processed frames |
| Equivalent swing window | Video-only VP9 WebM, 9.810 s | 1 | Completed in 4.833 s with 72 processed frames |
| Phone-shaped VFR window | H.264 MP4, 540×960, 9.743 s, 25.25 average fps | 1 | Completed in 4.764 s with 77 processed frames |
| Damaged-file control | Metadata-readable fast-start H.264 MP4 truncated mid-bitstream | 1 | Rejected in 2.245 s after 37 progress frames with the expected incomplete/damaged message; editor and retry remained available |
| Recovery after damage | Valid VP9 WebM immediately after the truncated file | 1 | Completed in 4.766 s with 73 processed frames, without reload or Worker reinitialization |
| No-person control | MDN CC0 flower H.264/AAC MP4, 5.055 s | 1 | Completed in 1.628 s with 34 processed frames; conservatively abstained with 0 reps |
| Public WebM tail EOF | Wikimedia conventional swings, tail re-encoded as 9.900 s VP8 WebM, selection 0–9.900 s | 1 | Completed in 4.592 s with 72 processed frames; conservatively abstained with 0 reps |

Every valid Chrome 151 run completed without “Video decoding stalled” or an application error. Every valid fixture conservatively abstained with 0 reps; that is correct fail-closed behavior for this transport-oriented evidence set, not validation of coaching accuracy.

The same production-bundle scenarios also passed in the installed Google Chrome 150.0.7871.212 on macOS. That corroborating run covered all listed codecs and controls, including 10/10 exact-EOF completions, rejection and immediate recovery after the truncated MP4, and conservative abstention for the no-person and public WebM controls. The Chrome 151 table above is the current measurement record.

Before the EOF fix, the exact-EOF H.264 case failed 9 of 12 attempts with “Video decoding stalled.” Chrome emitted `ended` at the declared duration but did not present another frame, so an implementation that only checked completion inside `requestVideoFrameCallback` eventually fired its decoder timer. After native EOF handling and final one-frame backpressure were in place, the historical Chrome 150 run passed 10 consecutive attempts and the final Chrome 151 run passed 6/6.

The deliberately truncated fast-start MP4 exposed a second edge case: Chrome may move `currentTime` to the declared duration even though the last decoded frame is much earlier. Completion therefore uses the last decoded media timestamp—not `currentTime`—to reject incomplete selections.

A software-only headless browser run remains a known test-environment limitation: without GPU-backed inference, it can reach the 30-second whole-run cap after advancing only about five seconds through the media. This does not reproduce in the GPU-backed headful Chrome 151 matrix or the installed Chrome 150 matrix, but it prevents treating software-only headless timing as representative of a normal browser/device. Physical-device and cross-browser coverage remains outstanding below.

## Public sources and provenance

The source used to derive equivalent codec and layout fixtures is the [DVIDS Kettlebell Swing demonstration](https://www.dvidshub.net/video/548744/kettlebell-swing), downloaded as its [1024×576 MP4](https://d34w7g4gy10iej.cloudfront.net/video/1708/DOD_104811572/DOD_104811572-1024x576-1769k.mp4). It is a three-quarter-view transport source, so the strict side-view analyzer can abstain; it is not evidence of coaching accuracy. DVIDS identifies the work as public-domain US Department of Defense visual information; its [copyright guidance](https://www.dvidshub.net/about/copyright) still applies to endorsement, trademarks, and third-party rights.

Native WebM coverage uses [Kettlebell Swings AKA Conventional Swings](https://commons.wikimedia.org/wiki/File:Kettlebell_Swings_AKA_Conventional_Swings.webm) by Taco Fleur, licensed CC BY-SA 4.0. The negative control is MDN's [CC0 flower MP4](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4).

Verified source hashes:

```text
8689b913deda2aeb0139fbf750343fb75be6e8624936f541d3eb15abbe0d3ec7  dvids-proper-swing.mp4
4237273b39fc8d9acb97b86457a7b938481450c02f54c9a5bdf49761ff22c869  wikimedia-kettlebell-vp8.webm
0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451  mdn-flower.mp4
```

The following derived hashes identify the exact artifacts used on 2026-08-01 with FFmpeg 8.1.2. They are evidence identifiers, not promised outputs of the commands below; WebM mux metadata such as SegmentUID can vary across otherwise equivalent FFmpeg runs.

```text
bfb818cb1ee232b3eac3e450f3f89f6d0b68cb462e21150c00309248237df602  eof-h264-4.2s.mp4
afb54f99c89a1026031d88833883916bd41fc627abd4ffef9bd19a51eee05a61  positive-h264.mp4
f986d2c4f3419bbb30c718e58a4171439a969e16dd4905891a197bcaabc1ee25  positive-vp8.webm
392432e57e052ce67191711970fd1afb29bdc8371d2e4c818d2c2a0b6f3b07df  positive-vp9.webm
9f5c3f8f6b1977758d26e3c3c7e9079eb8234f7de8af81f37cae3a87f7f4b6a9  positive-portrait-vfr.mp4
631ce593c3b1bbb6afdf098abd297cbfd7ce26704525712193edc036b984f870  truncated-h264.mp4
1c95fa343157f3e4df16b9262436e6dd5979308ed345468e6de1616c6b2f563e  wikimedia-tail-vp8.webm
```

Public videos are not committed to this repository. Fetch and derive them in an isolated temporary directory:

```bash
kb_fixture_dir=$(mktemp -d /tmp/kb-form-video-fixtures.XXXXXX)

curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$kb_fixture_dir/dvids-proper-swing.mp4" \
  'https://d34w7g4gy10iej.cloudfront.net/video/1708/DOD_104811572/DOD_104811572-1024x576-1769k.mp4'

curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$kb_fixture_dir/wikimedia-kettlebell-vp8.webm" \
  'https://commons.wikimedia.org/wiki/Special:Redirect/file/Kettlebell_Swings_AKA_Conventional_Swings.webm'

curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$kb_fixture_dir/mdn-flower.mp4" \
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'

(
  cd "$kb_fixture_dir"
  shasum -a 256 -c <<'SHA256'
8689b913deda2aeb0139fbf750343fb75be6e8624936f541d3eb15abbe0d3ec7  dvids-proper-swing.mp4
4237273b39fc8d9acb97b86457a7b938481450c02f54c9a5bdf49761ff22c869  wikimedia-kettlebell-vp8.webm
0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451  mdn-flower.mp4
SHA256
)

ffmpeg -y -ss 10 -i "$kb_fixture_dir/dvids-proper-swing.mp4" -t 9.8 \
  -map 0:v:0 -map '0:a:0?' -vf 'format=yuv420p' \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 96k -movflags +faststart \
  "$kb_fixture_dir/positive-h264.mp4"

ffmpeg -y -ss 10 -i "$kb_fixture_dir/dvids-proper-swing.mp4" -t 9.8 \
  -map 0:v:0 -an -c:v libvpx -crf 10 -b:v 1M \
  "$kb_fixture_dir/positive-vp8.webm"

ffmpeg -y -ss 10 -i "$kb_fixture_dir/dvids-proper-swing.mp4" -t 9.8 \
  -map 0:v:0 -an -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 \
  "$kb_fixture_dir/positive-vp9.webm"
```

The portrait VFR fixture keeps the same movement window while alternating roughly 33 ms and 67 ms frame intervals:

```bash
ffmpeg -y -ss 10 -i "$kb_fixture_dir/dvids-proper-swing.mp4" -t 9.8 \
  -map 0:v:0 -an \
  -vf "crop=432:576:240:0,scale=540:720:flags=lanczos,pad=540:960:0:120:black,select='if(lt(mod(t,2),1),1,not(eq(mod(n,3),2)))',setpts=PTS-STARTPTS" \
  -fps_mode vfr -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p \
  -movflags +faststart "$kb_fixture_dir/positive-portrait-vfr.mp4"
```

The tested public WebM tail fixture was derived from 14.4–24.3 seconds of the Wikimedia source:

```bash
ffmpeg -y -ss 14.4 -i "$kb_fixture_dir/wikimedia-kettlebell-vp8.webm" -t 9.9 \
  -map 0:v:0 -an -c:v libvpx -crf 10 -b:v 1M \
  "$kb_fixture_dir/wikimedia-tail-vp8.webm"
```

Create the exact-EOF and deliberately damaged controls without modifying the valid source in place:

```bash
ffmpeg -y -ss 10 -i "$kb_fixture_dir/dvids-proper-swing.mp4" -t 4.2 \
  -map 0:v:0 -map '0:a:0?' -vf 'format=yuv420p' \
  -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 96k -movflags +faststart \
  "$kb_fixture_dir/eof-h264-4.2s.mp4"

head -c 550000 "$kb_fixture_dir/positive-h264.mp4" \
  > "$kb_fixture_dir/truncated-h264.mp4"
```

## Full regression checklist

The matrix above records the attempts actually completed in the stated Chrome environment. A broader browser/device regression run should apply the following checklist rather than assuming every assertion has already passed everywhere.

For each supported positive fixture:

- Load it through the real file input and object-URL path.
- Preview, seek, crop, and analyze through completion.
- Select through exact media duration as well as a mid-file window.
- Confirm there is no permanent spinner and controls recover after success, cancellation, and failure.
- Run another valid analysis immediately after every failure without reloading.
- Compare the H.264, VP8, VP9, portrait, and VFR variants for equivalent transport behavior.

Negative fixtures must fail closed: damaged media gets an incomplete/damaged message, unsupported codecs get container/codec guidance, and a clip without enough visible swing evidence returns **Not assessed** rather than fabricated pointers.

## Remaining release matrix

These checks are still required before claiming broad device compatibility:

- Current Firefox and Safari on desktop.
- Current iOS Safari and Android Chrome on physical phones.
- HEVC/H.265 MOV and MP4 on devices that advertise native support.
- Phone rotation metadata, HDR/10-bit variants, fragmented MP4, and 60 fps sources.
- Background/foreground interruption, memory pressure, and sustained thermal performance.
- Screen-reader and keyboard testing of both trim handles and the crop rectangle.

Native codecs and browser media behavior vary by operating system and hardware. This matrix is therefore versioned evidence, not a claim that every file bearing an accepted extension will decode.
