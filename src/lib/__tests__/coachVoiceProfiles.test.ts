import { describe, expect, it } from "vitest";
import { FRAMING_CUES } from "../framingCoach";
import {
  COACH_VOICE_DISCLOSURE,
  COACH_VOICE_MESSAGES,
  COACH_VOICE_PROFILES,
  coachVoiceMessage,
  getCoachVoiceProfile,
  isCoachVoiceMessage,
  isFramingVoiceMessageId,
  isVoiceProfileId
} from "../coachVoiceProfiles";

describe("coach voice profiles", () => {
  it("publishes exactly two distinct, accessible AI voice profiles", () => {
    expect(COACH_VOICE_PROFILES).toHaveLength(2);
    expect(COACH_VOICE_PROFILES.map(({ id }) => id)).toEqual([
      "male-command",
      "female-command"
    ]);
    expect(new Set(COACH_VOICE_PROFILES.map(({ characterName }) => characterName)).size).toBe(2);
    expect(new Set(COACH_VOICE_PROFILES.map(({ descriptor }) => descriptor)).size).toBe(2);

    for (const profile of COACH_VOICE_PROFILES) {
      expect(profile.descriptor).toMatch(/British (male|female)/i);
      expect(profile.accessibleLabel).toContain(profile.characterName);
      expect(profile.accessibleLabel).toMatch(/Maritime Command/i);
      expect(profile.accessibleLabel).toMatch(/AI-generated/i);
    }

    expect(COACH_VOICE_DISCLOSURE).toMatch(/AI-generated/i);
    expect(COACH_VOICE_DISCLOSURE).toMatch(/not human recordings/i);
    expect(COACH_VOICE_DISCLOSURE).toMatch(/no military affiliation/i);
  });

  it("resolves only the two fixed profile identifiers", () => {
    expect(isVoiceProfileId("male-command")).toBe(true);
    expect(isVoiceProfileId("female-command")).toBe(true);
    expect(isVoiceProfileId("custom-command")).toBe(false);
    expect(getCoachVoiceProfile("male-command").characterName).toBe("Harbour");
    expect(getCoachVoiceProfile("female-command").characterName).toBe("Crown");
  });

  it("keeps every framing message byte-for-byte aligned with the visual cue", () => {
    for (const cue of Object.values(FRAMING_CUES)) {
      expect(COACH_VOICE_MESSAGES[cue.id]).toBe(cue.speech);
      expect(isFramingVoiceMessageId(cue.id)).toBe(true);
    }
  });

  it("creates fixed messages and refuses altered or unknown speech", () => {
    expect(coachVoiceMessage("coach-on")).toEqual({
      id: "coach-on",
      speech: "Voice framing coach on."
    });
    expect(coachVoiceMessage("male-command-selected").speech).toBe(
      "Male British coach selected."
    );
    expect(coachVoiceMessage("female-command-selected").speech).toBe(
      "Female British coach selected."
    );

    expect(isCoachVoiceMessage(coachVoiceMessage("move-left"))).toBe(true);
    expect(isCoachVoiceMessage({ id: "move-left", speech: "Move now." })).toBe(false);
    expect(isCoachVoiceMessage({ id: "unknown", speech: "Move now." })).toBe(false);
    expect(isCoachVoiceMessage(null)).toBe(false);
  });
});
