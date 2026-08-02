import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve("src/assets/coach-voices/v2");
const MANIFEST_PATH = resolve("src/data/coachVoiceManifest.v2.json");
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
const EXPECTED_COUNT = PROFILE_IDS.length * Object.keys(CUES).length;
const MAX_CLIP_BYTES = 96 * 1024;
const MAX_PACK_BYTES = 2 * 1024 * 1024;
const PAIR_LIMITS = Object.freeze({
  maxCueDurationRelativeDelta: 0.2,
  maxProfileDurationRelativeDelta: 0.1,
  maxCueActiveDurationRelativeDelta: 0.2,
  maxCuePauseShareDelta: 0.1,
  cueInternalPauseDeltaAllowanceFloorSeconds: 0.22,
  maxCueInternalPauseDeltaPairedMeanShare: 0.1,
  maxProfilePauseShareDelta: 0.05,
  maxProfileActiveDurationRelativeDelta: 0.1,
  maxInternalPauseCountDelta: 1,
  maxCueLoudnessDeltaLu: 0.5,
  maxProfileMeanLoudnessDeltaLu: 0.25,
  minimumSilenceSeconds: 0.1,
  silenceNoiseDb: -42,
  edgeWindowMs: 120
});
const DISCLOSURE =
  "Original AI-generated British Maritime Command character voices; not recordings of a human coach and not affiliated with a military unit.";
const PROVENANCE = Object.freeze({
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
});
const MASTERING = Object.freeze({
  codec: "mp3",
  mimeType: "audio/mpeg",
  sampleRate: 24000,
  channels: 1,
  bitrateKbps: 64,
  targetIntegratedLufs: -16,
  maximumTruePeakDbtp: -1
});

function fail(message) {
  throw new Error(`[voice:verify] ${message}`);
}

function exactRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) =>
      key === expectedKeys[index] && Object.is(actual[key], expected[key])
    )
  );
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    fail(`${command} failed: ${error?.stderr?.toString().trim() || error?.message}`);
  }
}

function loudness(path) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-"
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  if (result.error || result.status !== 0) {
    fail(`ffmpeg could not analyze ${relative(process.cwd(), path)}.`);
  }
  const summary = (result.stderr ?? "").split("Summary:").at(-1) ?? "";
  const integrated = Number(
    summary.match(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/)?.[1]
  );
  const truePeak = Number(summary.match(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  if (!Number.isFinite(integrated) || !Number.isFinite(truePeak)) {
    fail(`Could not parse loudness for ${relative(process.cwd(), path)}.`);
  }
  return { integrated, truePeak };
}

function relativeDelta(first, second) {
  const pairedMean = (first + second) / 2;
  return pairedMean === 0 ? 0 : Math.abs(first - second) / pairedMean;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function silenceMetrics(path, durationSeconds) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-af",
      `silencedetect=noise=${PAIR_LIMITS.silenceNoiseDb}dB:` +
        `d=${PAIR_LIMITS.minimumSilenceSeconds}`,
      "-f",
      "null",
      "-"
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  if (result.error || result.status !== 0) {
    fail(`ffmpeg could not detect silence in ${relative(process.cwd(), path)}.`);
  }

  const intervals = [];
  const eventPattern =
    /silence_(start|end):\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*(-?[\d.]+))?/g;
  let pendingStart = null;
  for (const match of (result.stderr ?? "").matchAll(eventPattern)) {
    const event = match[1];
    const timestamp = Number(match[2]);
    if (!Number.isFinite(timestamp)) {
      fail(`Could not parse silence timing for ${relative(process.cwd(), path)}.`);
    }
    if (event === "start") {
      if (pendingStart !== null) {
        fail(`Malformed silence timing for ${relative(process.cwd(), path)}.`);
      }
      pendingStart = timestamp;
      continue;
    }

    const reportedDuration = Number(match[3]);
    const start = pendingStart ?? timestamp - reportedDuration;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(reportedDuration) ||
      timestamp < start
    ) {
      fail(`Malformed silence interval for ${relative(process.cwd(), path)}.`);
    }
    intervals.push({ start, end: timestamp });
    pendingStart = null;
  }
  if (pendingStart !== null) {
    intervals.push({ start: pendingStart, end: durationSeconds });
  }

  const timingToleranceSeconds = 0.01;
  let previousEnd = 0;
  const normalizedIntervals = intervals.map(({ start, end }) => {
    if (
      start < -timingToleranceSeconds ||
      end > durationSeconds + timingToleranceSeconds ||
      start < previousEnd - timingToleranceSeconds
    ) {
      fail(`Silence timing is outside the clip for ${relative(process.cwd(), path)}.`);
    }
    const normalized = {
      start: Math.max(0, start),
      end: Math.min(durationSeconds, end)
    };
    previousEnd = normalized.end;
    return normalized;
  });
  const totalSilenceSeconds = normalizedIntervals.reduce(
    (total, interval) => total + Math.max(0, interval.end - interval.start),
    0
  );
  const edgeWindowSeconds = PAIR_LIMITS.edgeWindowMs / 1000;
  const internalIntervals = normalizedIntervals.filter(
    (interval) =>
      interval.start > edgeWindowSeconds &&
      interval.end < durationSeconds - edgeWindowSeconds
  );
  const internalSilenceSeconds = internalIntervals.reduce(
    (total, interval) => total + interval.end - interval.start,
    0
  );
  const activeDurationSeconds = Math.max(
    0,
    durationSeconds - totalSilenceSeconds
  );
  if (activeDurationSeconds === 0) {
    fail(`${relative(process.cwd(), path)} contains no detected active audio.`);
  }

  return {
    activeDurationSeconds,
    internalPauseCount: internalIntervals.length,
    internalSilenceSeconds,
    pauseShare: internalSilenceSeconds / durationSeconds
  };
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
if (
  manifest.schemaVersion !== 1 ||
  manifest.packId !== "maritime-command-v2" ||
  manifest.generatedOn !== "2026-08-01" ||
  manifest.releaseStatus !== "candidate" ||
  manifest.disclosure !== DISCLOSURE ||
  !exactRecord(manifest.provenance, PROVENANCE) ||
  !exactRecord(manifest.mastering, MASTERING)
) {
  fail("Manifest identity, provenance, or licence metadata is invalid.");
}

const expectedFiles = PROFILE_IDS.flatMap((profile) =>
  Object.keys(CUES).map((cueId) => `${profile}/${cueId}.mp3`)
).sort();
const rootEntries = await readdir(ROOT, { withFileTypes: true });
if (
  rootEntries.length !== PROFILE_IDS.length ||
  rootEntries.some(
    (entry) => !entry.isDirectory() || !PROFILE_IDS.includes(entry.name)
  )
) {
  fail("Voice-pack root must contain only the two expected profile directories.");
}
const actualFiles = (
  await Promise.all(
    PROFILE_IDS.map(async (profile) => {
      const entries = await readdir(join(ROOT, profile), { withFileTypes: true });
      if (entries.some((entry) => !entry.isFile())) {
        fail(`Voice profile ${profile} must contain files only.`);
      }
      return entries.map((entry) => `${profile}/${entry.name}`);
    })
  )
).flat().sort();
if (
  actualFiles.length !== EXPECTED_COUNT ||
  actualFiles.some((file, index) => file !== expectedFiles[index])
) {
  fail(`Expected the exact ${EXPECTED_COUNT}-file MP3 set; found ${actualFiles.length}.`);
}

if (
  !manifest.profiles ||
  Object.keys(manifest.profiles).sort().join("\0") !== [...PROFILE_IDS].sort().join("\0")
) {
  fail("Manifest must contain exactly the two expected profiles.");
}

const allHashes = new Set();
const pairMeasurements = Object.fromEntries(
  PROFILE_IDS.map((profile) => [profile, new Map()])
);
let totalBytes = 0;
for (const profile of PROFILE_IDS) {
  const entries = manifest.profiles?.[profile];
  if (!entries || Object.keys(entries).length !== Object.keys(CUES).length) {
    fail(`Manifest profile ${profile} is incomplete.`);
  }
  for (const [cueId, speech] of Object.entries(CUES)) {
    const entry = entries[cueId];
    if (!entry || entry.speech !== speech || entry.mimeType !== "audio/mpeg") {
      fail(`Manifest transcript or MIME mismatch for ${profile}/${cueId}.`);
    }
    const expectedRelativePath = `${profile}/${cueId}.mp3`;
    if (entry.file !== expectedRelativePath || !actualFiles.includes(expectedRelativePath)) {
      fail(`Manifest path mismatch for ${profile}/${cueId}.`);
    }
    const path = join(ROOT, entry.file);
    const details = await stat(path);
    const contents = await readFile(path);
    const hash = createHash("sha256").update(contents).digest("hex");
    if (
      !details.isFile() ||
      details.size === 0 ||
      details.size !== entry.bytes ||
      details.size > MAX_CLIP_BYTES ||
      hash !== entry.sha256 ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      fail(`Size or integrity mismatch for ${profile}/${cueId}.`);
    }
    const probe = JSON.parse(
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
    const streams = probe.streams ?? [];
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
    const audio = audioStreams[0];
    const durationMs = Math.round(Number(probe.format?.duration) * 1000);
    const streamTagNames = Object.keys(audio?.tags ?? {});
    const formatTagNames = Object.keys(probe.format?.tags ?? {});
    if (
      streams.length !== 1 ||
      audioStreams.length !== 1 ||
      audio.codec_name !== "mp3" ||
      Number(audio.sample_rate) !== MASTERING.sampleRate ||
      Number(audio.channels) !== MASTERING.channels ||
      Number(audio.bit_rate) !== MASTERING.bitrateKbps * 1000 ||
      probe.format?.format_name !== "mp3" ||
      streamTagNames.length !== 0 ||
      formatTagNames.some((name) => name !== "encoder") ||
      durationMs !== entry.durationMs ||
      durationMs < 350 ||
      durationMs > 6500
    ) {
      fail(`Media properties failed for ${profile}/${cueId}.`);
    }
    const measured = loudness(path);
    if (
      measured.integrated < -17 ||
      measured.integrated > -15 ||
      measured.truePeak > -1 ||
      measured.integrated !== entry.integratedLufs ||
      measured.truePeak !== entry.truePeakDbtp
    ) {
      fail(`Loudness failed for ${profile}/${cueId}.`);
    }
    if (allHashes.has(hash)) {
      fail(`Duplicate audio content detected at ${profile}/${cueId}.`);
    }
    allHashes.add(hash);
    totalBytes += details.size;
    pairMeasurements[profile].set(cueId, {
      durationSeconds: durationMs / 1000,
      integratedLufs: measured.integrated,
      ...silenceMetrics(path, durationMs / 1000)
    });
  }
}

if (totalBytes > MAX_PACK_BYTES) {
  fail(`Voice pack is ${totalBytes} bytes; maximum is ${MAX_PACK_BYTES}.`);
}

const [firstProfile, secondProfile] = PROFILE_IDS;
for (const cueId of Object.keys(CUES)) {
  const first = pairMeasurements[firstProfile].get(cueId);
  const second = pairMeasurements[secondProfile].get(cueId);
  const cueLabel = `${firstProfile}/${secondProfile} ${cueId}`;
  const durationDelta = relativeDelta(
    first.durationSeconds,
    second.durationSeconds
  );
  if (durationDelta > PAIR_LIMITS.maxCueDurationRelativeDelta) {
    fail(
      `Pair duration delta for ${cueLabel} is ${(durationDelta * 100).toFixed(1)}%; ` +
        `maximum is ${(PAIR_LIMITS.maxCueDurationRelativeDelta * 100).toFixed(1)}%.`
    );
  }
  const activeDurationDelta = relativeDelta(
    first.activeDurationSeconds,
    second.activeDurationSeconds
  );
  if (activeDurationDelta > PAIR_LIMITS.maxCueActiveDurationRelativeDelta) {
    fail(
      `Pair active-duration delta for ${cueLabel} is ` +
        `${(activeDurationDelta * 100).toFixed(1)}%; maximum is ` +
        `${(PAIR_LIMITS.maxCueActiveDurationRelativeDelta * 100).toFixed(1)}%.`
    );
  }
  const pauseShareDelta = Math.abs(first.pauseShare - second.pauseShare);
  if (pauseShareDelta > PAIR_LIMITS.maxCuePauseShareDelta) {
    fail(
      `Pair pause-share delta for ${cueLabel} is ` +
        `${(pauseShareDelta * 100).toFixed(1)} percentage points; maximum is ` +
        `${(PAIR_LIMITS.maxCuePauseShareDelta * 100).toFixed(1)}.`
    );
  }
  const pairedMeanDurationSeconds =
    (first.durationSeconds + second.durationSeconds) / 2;
  const maximumInternalPauseDeltaSeconds = Math.max(
    PAIR_LIMITS.cueInternalPauseDeltaAllowanceFloorSeconds,
    pairedMeanDurationSeconds *
      PAIR_LIMITS.maxCueInternalPauseDeltaPairedMeanShare
  );
  const internalPauseDeltaSeconds = Math.abs(
    first.internalSilenceSeconds - second.internalSilenceSeconds
  );
  if (internalPauseDeltaSeconds > maximumInternalPauseDeltaSeconds) {
    fail(
      `Pair internal-pause duration delta for ${cueLabel} is ` +
        `${Math.round(internalPauseDeltaSeconds * 1000)} ms; maximum is ` +
        `${Math.round(maximumInternalPauseDeltaSeconds * 1000)} ms.`
    );
  }
  const pauseCountDelta = Math.abs(
    first.internalPauseCount - second.internalPauseCount
  );
  if (pauseCountDelta > PAIR_LIMITS.maxInternalPauseCountDelta) {
    fail(
      `Pair internal-pause count delta for ${cueLabel} is ${pauseCountDelta}; ` +
        `maximum is ${PAIR_LIMITS.maxInternalPauseCountDelta}.`
    );
  }
  const loudnessDelta = Math.abs(
    first.integratedLufs - second.integratedLufs
  );
  if (loudnessDelta > PAIR_LIMITS.maxCueLoudnessDeltaLu) {
    fail(
      `Pair loudness delta for ${cueLabel} is ${loudnessDelta.toFixed(1)} LU; ` +
        `maximum is ${PAIR_LIMITS.maxCueLoudnessDeltaLu.toFixed(1)} LU.`
    );
  }
}

function summarizeProfile(profile) {
  const measurements = [...pairMeasurements[profile].values()];
  const durationSeconds = measurements.reduce(
    (total, measurement) => total + measurement.durationSeconds,
    0
  );
  const internalSilenceSeconds = measurements.reduce(
    (total, measurement) => total + measurement.internalSilenceSeconds,
    0
  );
  return {
    activeDurationSeconds: measurements.reduce(
      (total, measurement) => total + measurement.activeDurationSeconds,
      0
    ),
    durationSeconds,
    meanLufs: mean(measurements.map((measurement) => measurement.integratedLufs)),
    pauseShare: internalSilenceSeconds / durationSeconds
  };
}

const firstSummary = summarizeProfile(firstProfile);
const secondSummary = summarizeProfile(secondProfile);
const profileDurationDelta = relativeDelta(
  firstSummary.durationSeconds,
  secondSummary.durationSeconds
);
if (profileDurationDelta > PAIR_LIMITS.maxProfileDurationRelativeDelta) {
  fail(
    `Pair profile-duration delta is ${(profileDurationDelta * 100).toFixed(1)}%; ` +
      `maximum is ${(PAIR_LIMITS.maxProfileDurationRelativeDelta * 100).toFixed(1)}%.`
  );
}
const profileActiveDurationDelta = relativeDelta(
  firstSummary.activeDurationSeconds,
  secondSummary.activeDurationSeconds
);
if (
  profileActiveDurationDelta >
  PAIR_LIMITS.maxProfileActiveDurationRelativeDelta
) {
  fail(
    `Pair profile active-duration delta is ` +
      `${(profileActiveDurationDelta * 100).toFixed(1)}%; maximum is ` +
      `${(PAIR_LIMITS.maxProfileActiveDurationRelativeDelta * 100).toFixed(1)}%.`
  );
}
const profilePauseShareDelta = Math.abs(
  firstSummary.pauseShare - secondSummary.pauseShare
);
if (profilePauseShareDelta > PAIR_LIMITS.maxProfilePauseShareDelta) {
  fail(
    `Pair profile pause-share delta is ` +
      `${(profilePauseShareDelta * 100).toFixed(1)} percentage points; maximum is ` +
      `${(PAIR_LIMITS.maxProfilePauseShareDelta * 100).toFixed(1)}.`
  );
}
const profileMeanLoudnessDelta = Math.abs(
  firstSummary.meanLufs - secondSummary.meanLufs
);
if (profileMeanLoudnessDelta > PAIR_LIMITS.maxProfileMeanLoudnessDeltaLu) {
  fail(
    `Pair profile mean-loudness delta is ` +
      `${profileMeanLoudnessDelta.toFixed(2)} LU; maximum is ` +
      `${PAIR_LIMITS.maxProfileMeanLoudnessDeltaLu.toFixed(2)} LU.`
  );
}

console.log(
  `[voice:verify] OK — ${EXPECTED_COUNT} distinct clips, ${totalBytes} bytes, ` +
    "24 kHz mono MP3, verified hashes, mastering limits, and pair parity."
);
