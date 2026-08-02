const MPEG_2_LAYER_3_SAMPLES_PER_FRAME = 576;
const PROBE_PADDING_TOLERANCE_FRAMES = 3;
const BITRATE_RELATIVE_TOLERANCE = 0.01;
const ALLOWED_METADATA_TAGS = new Set(["encoder"]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateVoiceMediaProbe({
  probe,
  expectedDurationMs,
  mastering,
  minimumDurationMs = 350,
  maximumDurationMs = 6500
}) {
  const issues = [];
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const audioStreams = streams.filter((stream) => stream?.codec_type === "audio");
  const audio = audioStreams[0];
  const sampleRate = finiteNumber(audio?.sample_rate);
  const channels = finiteNumber(audio?.channels);
  const bitrate = finiteNumber(audio?.bit_rate);
  const probedDurationSeconds = finiteNumber(probe?.format?.duration);
  const probedDurationMs =
    probedDurationSeconds === null
      ? null
      : Math.round(probedDurationSeconds * 1000);

  if (streams.length !== 1 || audioStreams.length !== 1) {
    issues.push("expected exactly one audio stream");
  }
  if (audio?.codec_name !== "mp3" || probe?.format?.format_name !== "mp3") {
    issues.push("expected MP3 stream and container");
  }
  if (sampleRate !== mastering.sampleRate || channels !== mastering.channels) {
    issues.push("sample rate or channel count differs from mastering policy");
  }

  const expectedBitrate = mastering.bitrateKbps * 1000;
  const bitrateTolerance = Math.max(
    1,
    Math.round(expectedBitrate * BITRATE_RELATIVE_TOLERANCE)
  );
  if (bitrate === null || Math.abs(bitrate - expectedBitrate) > bitrateTolerance) {
    issues.push("stream bitrate differs from mastering policy");
  }

  if (
    !Number.isSafeInteger(expectedDurationMs) ||
    expectedDurationMs < minimumDurationMs ||
    expectedDurationMs > maximumDurationMs
  ) {
    issues.push("manifest duration is outside the release bounds");
  }

  const durationToleranceMs = Math.ceil(
    (MPEG_2_LAYER_3_SAMPLES_PER_FRAME * PROBE_PADDING_TOLERANCE_FRAMES * 1000) /
      mastering.sampleRate
  );
  if (
    probedDurationMs === null ||
    Math.abs(probedDurationMs - expectedDurationMs) > durationToleranceMs
  ) {
    issues.push("probed duration exceeds the MP3 padding tolerance");
  }

  const tagNames = [
    ...Object.keys(audio?.tags ?? {}),
    ...Object.keys(probe?.format?.tags ?? {})
  ];
  if (tagNames.some((name) => !ALLOWED_METADATA_TAGS.has(name))) {
    issues.push("unexpected metadata tag is present");
  }

  return {
    durationToleranceMs,
    issues,
    probedDurationMs
  };
}
