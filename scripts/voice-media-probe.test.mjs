import { describe, expect, it } from "vitest";
import { validateVoiceMediaProbe } from "./voice-media-probe.mjs";

const mastering = Object.freeze({
  bitrateKbps: 64,
  channels: 1,
  sampleRate: 24000
});

function probe({
  bitrate = "64000",
  duration = "1.257875",
  formatTags = { encoder: "Lavf62.12.102" },
  streamTags
} = {}) {
  return {
    streams: [
      {
        bit_rate: bitrate,
        channels: 1,
        codec_name: "mp3",
        codec_type: "audio",
        sample_rate: "24000",
        ...(streamTags ? { tags: streamTags } : {})
      }
    ],
    format: {
      duration,
      format_name: "mp3",
      tags: formatTags
    }
  };
}

describe("voice media probe portability", () => {
  it("accepts the exact FFprobe 8 representation", () => {
    const result = validateVoiceMediaProbe({
      probe: probe(),
      expectedDurationMs: 1258,
      mastering
    });

    expect(result.issues).toEqual([]);
    expect(result.probedDurationMs).toBe(1258);
    expect(result.durationToleranceMs).toBe(72);
  });

  it("accepts FFprobe 6 padding and bitrate reporting differences", () => {
    const result = validateVoiceMediaProbe({
      probe: probe({
        bitrate: "63999",
        duration: "1.320000",
        formatTags: {},
        streamTags: { encoder: "Lavf60.16.100" }
      }),
      expectedDurationMs: 1258,
      mastering
    });

    expect(result.issues).toEqual([]);
    expect(result.probedDurationMs).toBe(1320);
  });

  it("rejects media outside codec, bitrate, duration, and metadata policy", () => {
    const invalid = probe({
      bitrate: "60000",
      duration: "1.400000",
      formatTags: { artist: "private release data" }
    });
    invalid.streams[0].codec_name = "aac";

    const result = validateVoiceMediaProbe({
      probe: invalid,
      expectedDurationMs: 1258,
      mastering
    });

    expect(result.issues).toEqual([
      "expected MP3 stream and container",
      "stream bitrate differs from mastering policy",
      "probed duration exceeds the MP3 padding tolerance",
      "unexpected metadata tag is present"
    ]);
  });

  it("rejects missing and malformed probe values", () => {
    const result = validateVoiceMediaProbe({
      probe: { streams: [], format: {} },
      expectedDurationMs: Number.NaN,
      mastering
    });

    expect(result.issues).toContain("expected exactly one audio stream");
    expect(result.issues).toContain("manifest duration is outside the release bounds");
    expect(result.issues).toContain(
      "probed duration exceeds the MP3 padding tolerance"
    );
  });
});
