import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";

const SOURCE_ROOT = resolve(process.argv[2] ?? "");
const OUTPUT_ROOT = resolve(process.argv[3] ?? "src/assets/coach-voices/v2");
const MANIFEST_PATH = resolve(
  process.argv[4] ?? "src/data/coachVoiceManifest.v2.json"
);
const PROFILE_IDS = ["male-command", "female-command"];
const CUES = Object.freeze({
  finding: "Step into the camera view.",
  "adjust-frame": "Bring your full body into view.",
  "move-left": "Move a little left in the frame.",
  "move-right": "Move a little right in the frame.",
  "step-back": "Step away from the camera. Keep your head, hands, and feet in view.",
  "move-closer": "Move a little closer.",
  "turn-side-on": "Turn side-on to the camera.",
  ready: "Great. You are in a good position.",
  "coach-on": "Voice framing coach on.",
  "male-command-selected": "Male British coach selected.",
  "female-command-selected": "Female British coach selected."
});
const PREFILTER = [
  "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-50dB",
  "areverse",
  "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-50dB",
  "afade=t=in:d=0.015",
  "areverse",
  "afade=t=in:d=0.005"
].join(",");
const TARGET_LUFS = -16;
const MIN_LUFS = -17;
const MAX_LUFS = -15;
const MAX_TRUE_PEAK_DBTP = -1;
const LIMITER_LINEAR = 0.7943;
const MAX_CLIP_BYTES = 96 * 1024;
const MAX_PACK_BYTES = 2 * 1024 * 1024;

function fail(message) {
  throw new Error(`[voice:master] ${message}`);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      ...options
    });
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    fail(`${command} failed: ${detail}`);
  }
}

function captureFfmpegStderr(args) {
  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    fail(`ffmpeg failed: ${result.stderr?.trim() || result.error?.message || "unknown error"}`);
  }
  return result.stderr ?? "";
}

function analyzeLoudness(path) {
  const stderr = captureFfmpegStderr([
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-filter_complex",
    "ebur128=peak=true",
    "-f",
    "null",
    "-"
  ]);
  const summary = stderr.split("Summary:").at(-1) ?? "";
  const integrated = Number(
    summary.match(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/)?.[1]
  );
  const truePeak = Number(summary.match(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  if (!Number.isFinite(integrated) || !Number.isFinite(truePeak)) {
    fail(`Could not parse loudness for ${relative(process.cwd(), path)}.`);
  }
  return { integratedLufs: integrated, truePeakDbtp: truePeak };
}

function analyzeForTwoPass(path) {
  const stderr = captureFfmpegStderr([
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-af",
    `${PREFILTER},loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=7:print_format=json`,
    "-f",
    "null",
    "-"
  ]);
  const match = stderr.match(/\{\s*"input_i".*?\}/s);
  if (!match) {
    fail(`Could not analyze ${relative(process.cwd(), path)} for normalization.`);
  }
  return JSON.parse(match[0]);
}

function encode(input, output, filter) {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-af",
    filter,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-map_metadata",
    "-1",
    output,
    "-y"
  ]);
}

function probe(path) {
  const result = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path
    ])
  );
  const streams = result.streams ?? [];
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  if (streams.length !== 1 || audioStreams.length !== 1) {
    fail(`${relative(process.cwd(), path)} must contain exactly one audio stream.`);
  }
  const audio = audioStreams[0];
  return {
    codec: audio.codec_name,
    sampleRate: Number(audio.sample_rate),
    channels: Number(audio.channels),
    durationMs: Math.round(Number(result.format?.duration) * 1000)
  };
}

if (!process.argv[2]) {
  fail(
    "Pass a private raw-WAV directory: node scripts/master-coach-voice-pack.mjs <source> [output] [manifest]."
  );
}

await mkdir(OUTPUT_ROOT, { recursive: true });
await mkdir(dirname(MANIFEST_PATH), { recursive: true });

const manifest = {
  schemaVersion: 1,
  packId: "maritime-command-v2",
  generatedOn: "2026-08-01",
  releaseStatus: "candidate",
  disclosure:
    "Original AI-generated British Maritime Command character voices; not recordings of a human coach and not affiliated with a military unit.",
  provenance: {
    voiceDesignModel: "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
    voiceDesignRevision: "7d3824abff87e49756bb0f83fb5411de75d160c4",
    upstreamVoiceDesignModel: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    upstreamVoiceDesignRevision: "5ecdb67327fd37bb2e042aab12ff7391903235d3",
    cloneModel: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
    cloneModelRevision: "a6eb4f68e4b056f1215157bb696209bc82a6db48",
    upstreamCloneModel: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    upstreamCloneRevision: "fd4b254389122332181a7c3db7f27e918eec64e3",
    license: "Apache-2.0",
    syntheticIdentity: true,
    namedPersonImitation: false
  },
  mastering: {
    codec: "mp3",
    mimeType: "audio/mpeg",
    sampleRate: 24000,
    channels: 1,
    bitrateKbps: 64,
    targetIntegratedLufs: TARGET_LUFS,
    maximumTruePeakDbtp: MAX_TRUE_PEAK_DBTP
  },
  profiles: {}
};

let totalBytes = 0;
for (const profile of PROFILE_IDS) {
  const outputDirectory = join(OUTPUT_ROOT, profile);
  await mkdir(outputDirectory, { recursive: true });
  const profileManifest = {};
  for (const [cueId, speech] of Object.entries(CUES)) {
    const input = join(SOURCE_ROOT, profile, `${cueId}.wav`);
    const output = join(outputDirectory, `${cueId}.mp3`);
    const measured = analyzeForTwoPass(input);
    const normalizer = [
      `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=7`,
      `measured_I=${measured.input_i}`,
      `measured_TP=${measured.input_tp}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      "linear=true"
    ].join(":");
    encode(input, output, `${PREFILTER},${normalizer},apad=pad_dur=0.08`);

    let loudness = analyzeLoudness(output);
    if (loudness.integratedLufs < MIN_LUFS || loudness.integratedLufs > MAX_LUFS) {
      const gain = TARGET_LUFS - loudness.integratedLufs;
      encode(
        input,
        output,
        `${PREFILTER},loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=7,` +
          `volume=${gain.toFixed(1)}dB,` +
          `alimiter=limit=${LIMITER_LINEAR}:attack=5:release=50:level=false,` +
          "apad=pad_dur=0.08"
      );
      loudness = analyzeLoudness(output);
    }

    const media = probe(output);
    const contents = await readFile(output);
    const bytes = contents.byteLength;
    totalBytes += bytes;
    if (
      media.codec !== "mp3" ||
      media.sampleRate !== 24000 ||
      media.channels !== 1 ||
      media.durationMs < 350 ||
      media.durationMs > 6500 ||
      bytes > MAX_CLIP_BYTES ||
      loudness.integratedLufs < MIN_LUFS ||
      loudness.integratedLufs > MAX_LUFS ||
      loudness.truePeakDbtp > MAX_TRUE_PEAK_DBTP
    ) {
      fail(`Mastering limits failed for ${profile}/${cueId}.`);
    }
    profileManifest[cueId] = {
      speech,
      file: `${profile}/${basename(output)}`,
      mimeType: "audio/mpeg",
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes,
      durationMs: media.durationMs,
      integratedLufs: loudness.integratedLufs,
      truePeakDbtp: loudness.truePeakDbtp
    };
    console.log(
      `[voice:master] ${profile}/${cueId} — ${media.durationMs} ms, ${bytes} bytes, ` +
        `${loudness.integratedLufs.toFixed(1)} LUFS, ${loudness.truePeakDbtp.toFixed(1)} dBTP`
    );
  }
  manifest.profiles[profile] = profileManifest;
}

if (totalBytes > MAX_PACK_BYTES) {
  fail(`Voice pack is ${totalBytes} bytes; maximum is ${MAX_PACK_BYTES}.`);
}

await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `[voice:master] OK — ${PROFILE_IDS.length * Object.keys(CUES).length} clips, ` +
    `${totalBytes} bytes, manifest ${relative(process.cwd(), MANIFEST_PATH)}.`
);
