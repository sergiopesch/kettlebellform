import manifest from "../data/coachVoiceManifest.v2.json";
import {
  COACH_VOICE_MESSAGES,
  type CoachVoiceMessageId
} from "./coachVoicePolicy";
import type { VoiceProfileId } from "./coachVoiceProfiles";

export type CoachVoiceAsset = Readonly<{
  url: string;
  mimeType: "audio/mpeg";
  speech: string;
  sha256: string;
  bytes: number;
  durationMs: number;
}>;

type CoachVoiceAssetMap = Readonly<
  Record<VoiceProfileId, Readonly<Record<CoachVoiceMessageId, CoachVoiceAsset>>>
>;

const urls = {
  "male-command": {
    finding: new URL(
      "../assets/coach-voices/v2/male-command/finding.mp3?no-inline",
      import.meta.url
    ).href,
    "adjust-frame": new URL(
      "../assets/coach-voices/v2/male-command/adjust-frame.mp3?no-inline",
      import.meta.url
    ).href,
    "move-left": new URL(
      "../assets/coach-voices/v2/male-command/move-left.mp3?no-inline",
      import.meta.url
    ).href,
    "move-right": new URL(
      "../assets/coach-voices/v2/male-command/move-right.mp3?no-inline",
      import.meta.url
    ).href,
    "step-back": new URL(
      "../assets/coach-voices/v2/male-command/step-back.mp3?no-inline",
      import.meta.url
    ).href,
    "move-closer": new URL(
      "../assets/coach-voices/v2/male-command/move-closer.mp3?no-inline",
      import.meta.url
    ).href,
    "turn-side-on": new URL(
      "../assets/coach-voices/v2/male-command/turn-side-on.mp3?no-inline",
      import.meta.url
    ).href,
    ready: new URL(
      "../assets/coach-voices/v2/male-command/ready.mp3?no-inline",
      import.meta.url
    ).href,
    "coach-on": new URL(
      "../assets/coach-voices/v2/male-command/coach-on.mp3?no-inline",
      import.meta.url
    ).href,
    "male-command-selected": new URL(
      "../assets/coach-voices/v2/male-command/male-command-selected.mp3?no-inline",
      import.meta.url
    ).href,
    "female-command-selected": new URL(
      "../assets/coach-voices/v2/male-command/female-command-selected.mp3?no-inline",
      import.meta.url
    ).href
  },
  "female-command": {
    finding: new URL(
      "../assets/coach-voices/v2/female-command/finding.mp3?no-inline",
      import.meta.url
    ).href,
    "adjust-frame": new URL(
      "../assets/coach-voices/v2/female-command/adjust-frame.mp3?no-inline",
      import.meta.url
    ).href,
    "move-left": new URL(
      "../assets/coach-voices/v2/female-command/move-left.mp3?no-inline",
      import.meta.url
    ).href,
    "move-right": new URL(
      "../assets/coach-voices/v2/female-command/move-right.mp3?no-inline",
      import.meta.url
    ).href,
    "step-back": new URL(
      "../assets/coach-voices/v2/female-command/step-back.mp3?no-inline",
      import.meta.url
    ).href,
    "move-closer": new URL(
      "../assets/coach-voices/v2/female-command/move-closer.mp3?no-inline",
      import.meta.url
    ).href,
    "turn-side-on": new URL(
      "../assets/coach-voices/v2/female-command/turn-side-on.mp3?no-inline",
      import.meta.url
    ).href,
    ready: new URL(
      "../assets/coach-voices/v2/female-command/ready.mp3?no-inline",
      import.meta.url
    ).href,
    "coach-on": new URL(
      "../assets/coach-voices/v2/female-command/coach-on.mp3?no-inline",
      import.meta.url
    ).href,
    "male-command-selected": new URL(
      "../assets/coach-voices/v2/female-command/male-command-selected.mp3?no-inline",
      import.meta.url
    ).href,
    "female-command-selected": new URL(
      "../assets/coach-voices/v2/female-command/female-command-selected.mp3?no-inline",
      import.meta.url
    ).href
  }
} as const satisfies Record<VoiceProfileId, Record<CoachVoiceMessageId, string>>;

function profileAssets(profile: VoiceProfileId) {
  return Object.fromEntries(
    (Object.keys(COACH_VOICE_MESSAGES) as CoachVoiceMessageId[]).map((cueId) => {
      const metadata = manifest.profiles[profile][cueId];
      if (metadata.speech !== COACH_VOICE_MESSAGES[cueId]) {
        throw new Error(`Voice asset transcript mismatch for ${profile}/${cueId}.`);
      }
      return [
        cueId,
        Object.freeze({
          url: urls[profile][cueId],
          mimeType: "audio/mpeg" as const,
          speech: metadata.speech,
          sha256: metadata.sha256,
          bytes: metadata.bytes,
          durationMs: metadata.durationMs
        })
      ];
    })
  ) as Record<CoachVoiceMessageId, CoachVoiceAsset>;
}

export const COACH_VOICE_PACK_ID = manifest.packId;
export const COACH_VOICE_PACK_DISCLOSURE = manifest.disclosure;

export const COACH_VOICE_ASSETS: CoachVoiceAssetMap = Object.freeze({
  "male-command": Object.freeze(profileAssets("male-command")),
  "female-command": Object.freeze(profileAssets("female-command"))
});
