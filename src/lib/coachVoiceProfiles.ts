import { FRAMING_CUES, type FramingCueId } from "./framingCoach";
import type { CoachVoiceMessageId } from "./coachVoicePolicy";
export {
  COACH_VOICE_MESSAGES,
  coachVoiceMessage,
  isCoachVoiceMessage,
  isCoachVoiceMessageId,
  type CoachVoiceMessage,
  type CoachVoiceMessageId
} from "./coachVoicePolicy";

export type VoiceProfileId = "male-command" | "female-command";

export type CoachVoiceProfile = Readonly<{
  id: VoiceProfileId;
  descriptor: string;
  accessibleLabel: string;
  characterName: string;
}>;

export const COACH_VOICE_DISCLOSURE =
  "Original AI-generated voices—not human recordings; no military affiliation.";

export const COACH_VOICE_PROFILES = Object.freeze([
  Object.freeze({
    id: "male-command",
    descriptor: "British male",
    accessibleLabel: "Harbour, British male Maritime Command coach, AI-generated",
    characterName: "Harbour"
  }),
  Object.freeze({
    id: "female-command",
    descriptor: "British female",
    accessibleLabel: "Crown, British female Maritime Command coach, AI-generated",
    characterName: "Crown"
  })
] satisfies readonly CoachVoiceProfile[]);

export const DEFAULT_COACH_VOICE_PROFILE_ID: VoiceProfileId = "female-command";

export function isVoiceProfileId(value: unknown): value is VoiceProfileId {
  return value === "male-command" || value === "female-command";
}

export function getCoachVoiceProfile(id: VoiceProfileId): CoachVoiceProfile {
  return COACH_VOICE_PROFILES.find((profile) => profile.id === id)!;
}

const FRAMING_MESSAGE_IDS = Object.freeze(Object.keys(FRAMING_CUES) as FramingCueId[]);

export function isFramingVoiceMessageId(id: CoachVoiceMessageId): id is FramingCueId {
  return FRAMING_MESSAGE_IDS.includes(id as FramingCueId);
}
