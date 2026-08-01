export const COACH_VOICE_MESSAGES = Object.freeze({
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
} as const);

export type CoachVoiceMessageId = keyof typeof COACH_VOICE_MESSAGES;

export type CoachVoiceMessage = {
  [Id in CoachVoiceMessageId]: Readonly<{
    id: Id;
    speech: (typeof COACH_VOICE_MESSAGES)[Id];
  }>;
}[CoachVoiceMessageId];

export function isCoachVoiceMessageId(value: unknown): value is CoachVoiceMessageId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(COACH_VOICE_MESSAGES, value)
  );
}

export function isCoachVoiceMessage(value: unknown): value is CoachVoiceMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { id?: unknown; speech?: unknown };
  if (!isCoachVoiceMessageId(candidate.id) || typeof candidate.speech !== "string") {
    return false;
  }
  return COACH_VOICE_MESSAGES[candidate.id] === candidate.speech;
}

export function coachVoiceMessage<Id extends CoachVoiceMessageId>(
  id: Id
): Extract<CoachVoiceMessage, { id: Id }> {
  return Object.freeze({
    id,
    speech: COACH_VOICE_MESSAGES[id]
  }) as unknown as Extract<CoachVoiceMessage, { id: Id }>;
}
