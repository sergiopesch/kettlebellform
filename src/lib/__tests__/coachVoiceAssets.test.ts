import { describe, expect, it } from "vitest";
import {
  COACH_VOICE_ASSETS,
  COACH_VOICE_PACK_DISCLOSURE,
  COACH_VOICE_PACK_ID
} from "../coachVoiceAssets";
import { COACH_VOICE_MESSAGES, type CoachVoiceMessageId } from "../coachVoicePolicy";
import type { VoiceProfileId } from "../coachVoiceProfiles";

const profiles: VoiceProfileId[] = ["male-command", "female-command"];
const cueIds = Object.keys(COACH_VOICE_MESSAGES) as CoachVoiceMessageId[];

describe("coach voice assets", () => {
  it("publishes one complete, versioned asset for every profile and fixed message", () => {
    expect(COACH_VOICE_PACK_ID).toBe("maritime-command-v2");
    expect(COACH_VOICE_PACK_DISCLOSURE).toMatch(/AI-generated/i);
    expect(COACH_VOICE_PACK_DISCLOSURE).toMatch(/not affiliated/i);

    const urls = new Set<string>();
    const hashes = new Set<string>();
    for (const profile of profiles) {
      expect(Object.keys(COACH_VOICE_ASSETS[profile])).toEqual(cueIds);
      for (const cueId of cueIds) {
        const asset = COACH_VOICE_ASSETS[profile][cueId];
        expect(asset.url).toMatch(/\.mp3(?:\?|$)/);
        expect(asset.url).toContain("/coach-voices/v2/");
        expect(asset.mimeType).toBe("audio/mpeg");
        expect(asset.speech).toBe(COACH_VOICE_MESSAGES[cueId]);
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(asset.bytes).toBeGreaterThan(0);
        expect(asset.bytes).toBeLessThanOrEqual(96 * 1024);
        expect(asset.durationMs).toBeGreaterThanOrEqual(350);
        expect(asset.durationMs).toBeLessThanOrEqual(6_500);
        urls.add(asset.url);
        hashes.add(asset.sha256);
      }
    }

    expect(urls.size).toBe(profiles.length * cueIds.length);
    expect(hashes.size).toBe(profiles.length * cueIds.length);
  });

  it("uses a genuinely distinct rendering for the two character profiles", () => {
    for (const cueId of cueIds) {
      expect(COACH_VOICE_ASSETS["male-command"][cueId].sha256).not.toBe(
        COACH_VOICE_ASSETS["female-command"][cueId].sha256
      );
    }
  });
});
