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
  label: string;
  accessibleLabel: string;
  description: string;
  aiDisclosure: string;
  characterName: string;
  packId: "maritime-command-v2";
}>;

const AI_VOICE_DISCLOSURE =
  "Original AI-generated character voice; not a human coach recording and not affiliated with a military unit.";

export const COACH_VOICE_PROFILES = Object.freeze([
  Object.freeze({
    id: "male-command",
    label: "Maritime Command · British male",
    accessibleLabel: "British male Maritime Command coach, AI-generated",
    description: "Brisk British leadership delivery with disciplined warmth and forward drive.",
    aiDisclosure: AI_VOICE_DISCLOSURE,
    characterName: "Harbour",
    packId: "maritime-command-v2"
  }),
  Object.freeze({
    id: "female-command",
    label: "Maritime Command · British female",
    accessibleLabel: "British female Maritime Command coach, AI-generated",
    description: "Brisk British leadership delivery with disciplined warmth and forward drive.",
    aiDisclosure: AI_VOICE_DISCLOSURE,
    characterName: "Crown",
    packId: "maritime-command-v2"
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
