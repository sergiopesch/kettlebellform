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
  openAIVoice: "cedar" | "marin";
  instructions: string;
}>;

const AI_VOICE_DISCLOSURE =
  "AI-generated speech using an OpenAI built-in voice; this is not a recording of a human coach.";

export const COACH_VOICE_PROFILES = Object.freeze([
  Object.freeze({
    id: "male-command",
    label: "Command · British male",
    accessibleLabel: "British male command coach, AI-generated",
    description: "Crisp, calm British command delivery with a masculine presentation.",
    aiDisclosure: AI_VOICE_DISCLOSURE,
    openAIVoice: "cedar",
    instructions:
      "Speak in modern British English with a masculine presentation. Sound like a calm, disciplined military fitness instructor: concise, assured, and easy to hear. Never shout, intimidate, embellish, or add words."
  }),
  Object.freeze({
    id: "female-command",
    label: "Command · British female",
    accessibleLabel: "British female command coach, AI-generated",
    description: "Crisp, calm British command delivery with a feminine presentation.",
    aiDisclosure: AI_VOICE_DISCLOSURE,
    openAIVoice: "marin",
    instructions:
      "Speak in modern British English with a feminine presentation. Sound like a calm, disciplined military fitness instructor: concise, assured, and easy to hear. Never shout, intimidate, embellish, or add words."
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
