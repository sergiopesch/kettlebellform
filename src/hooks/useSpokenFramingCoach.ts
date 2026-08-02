import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_COACH_VOICE_PROFILE_ID,
  coachVoiceMessage,
  type CoachVoiceMessage,
  type CoachVoiceMessageId,
  type VoiceProfileId
} from "../lib/coachVoiceProfiles";
import { FRAMING_CUES, type FramingCue } from "../lib/framingCoach";
import {
  createCoachVoicePackClient,
  supportsCoachVoicePack,
  type CoachVoicePackClient
} from "../lib/coachVoicePackClient";

export type VoiceCoachAvailability = "loading" | "ready" | "unavailable";
export type VoiceCoachTransport = "off" | "loading" | "pack" | "device" | "visual";

type SpokenFramingOptions = {
  cue: FramingCue;
  automatic: boolean;
  guidanceEvidenceEpoch?: number;
  guidanceEvidenceValid?: boolean;
  motionActive?: boolean;
  sessionActive?: boolean;
};

const CORRECTION_STABLE_MS = 800;
const READY_STABLE_MS = 1_200;
const MIN_ANNOUNCEMENT_GAP_MS = 3_000;
const CORRECTION_REPEAT_MS = 7_000;
const READY_REARM_MS = 2_000;
const VOICE_DISCOVERY_TIMEOUT_MS = 1_500;
const RECENT_MOTION_COOLDOWN_MS = 4_000;

function chooseLocalVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const local = voices.filter((voice) => {
    const language = voice.lang.toLowerCase();
    return voice.localService && (language === "en" || language.startsWith("en-"));
  });
  return (
    local.find((voice) => voice.lang.toLowerCase() === "en-gb") ??
    local.find((voice) => voice.default) ??
    local[0] ??
    null
  );
}

export function useSpokenFramingCoach({
  cue,
  automatic,
  guidanceEvidenceEpoch = 0,
  guidanceEvidenceValid = true,
  motionActive = false,
  sessionActive = false
}: SpokenFramingOptions) {
  const speechSupported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;
  const packSupported = supportsCoachVoicePack();
  const [availability, setAvailability] = useState<VoiceCoachAvailability>(
    packSupported ? "ready" : speechSupported ? "loading" : "unavailable"
  );
  const [enabled, setEnabled] = useState(false);
  const [transport, setTransport] = useState<VoiceCoachTransport>("off");
  const [selectedProfile, setSelectedProfile] = useState<VoiceProfileId>(
    DEFAULT_COACH_VOICE_PROFILE_ID
  );
  const [stableGuidance, setStableGuidance] = useState(() => ({
    cue: FRAMING_CUES.finding,
    evidenceEpoch: guidanceEvidenceEpoch
  }));
  const [speechStatus, setSpeechStatus] = useState("");
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  const [motionCooldownActive, setMotionCooldownActive] = useState(false);
  const effectiveStableCue =
    guidanceEvidenceValid && stableGuidance.evidenceEpoch === guidanceEvidenceEpoch
      ? stableGuidance.cue
      : FRAMING_CUES.finding;
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const packClientRef = useRef<CoachVoicePackClient | null>(null);
  const activationEpochRef = useRef(0);
  const enabledRef = useRef(false);
  const selectedProfileRef = useRef<VoiceProfileId>(DEFAULT_COACH_VOICE_PROFILE_ID);
  const pageVisibleRef = useRef(pageVisible);
  const mountedRef = useRef(true);
  const lastSpokenAtRef = useRef(Number.NEGATIVE_INFINITY);
  const readyArmedRef = useRef(true);
  const rearmHandleRef = useRef<number | null>(null);
  const discoveryTimedOutRef = useRef(false);
  const previousSessionActiveRef = useRef(sessionActive);

  const cancelLocalSpeech = useCallback(() => {
    const utterance = activeUtteranceRef.current;
    if (!speechSupported || !utterance) {
      return;
    }
    activeUtteranceRef.current = null;
    utterance.onend = null;
    utterance.onerror = null;
    window.speechSynthesis.cancel();
  }, [speechSupported]);

  const cancelOwnedSpeech = useCallback(() => {
    activationEpochRef.current += 1;
    packClientRef.current?.cancel();
    cancelLocalSpeech();
  }, [cancelLocalSpeech]);

  const resetGuidanceState = useCallback(() => {
    setStableGuidance((current) =>
      current.cue.id === "finding" && current.evidenceEpoch === guidanceEvidenceEpoch
        ? current
        : { cue: FRAMING_CUES.finding, evidenceEpoch: guidanceEvidenceEpoch }
    );
    readyArmedRef.current = true;
    if (rearmHandleRef.current !== null) {
      window.clearTimeout(rearmHandleRef.current);
      rearmHandleRef.current = null;
    }
  }, [guidanceEvidenceEpoch]);

  const speakLocally = useCallback(
    (message: CoachVoiceMessage, onError?: () => void) => {
      const voice = voiceRef.current;
      if (!speechSupported || !voice) {
        return false;
      }
      cancelLocalSpeech();
      const utterance = new window.SpeechSynthesisUtterance(message.speech);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 1;
      utterance.pitch = 0.94;
      utterance.volume = 1;
      utterance.onend = () => {
        if (activeUtteranceRef.current === utterance) {
          activeUtteranceRef.current = null;
        }
      };
      utterance.onerror = (event) => {
        if (activeUtteranceRef.current === utterance) {
          activeUtteranceRef.current = null;
        }
        if (event.error === "canceled" || event.error === "interrupted") {
          return;
        }
        if (mountedRef.current) {
          setSpeechStatus("Device voice could not speak. Visual framing cues remain active.");
        }
        onError?.();
      };
      activeUtteranceRef.current = utterance;
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        activeUtteranceRef.current = null;
        if (mountedRef.current) {
          setSpeechStatus("Device voice could not speak. Visual framing cues remain active.");
        }
        onError?.();
        return false;
      }
      lastSpokenAtRef.current = performance.now();
      return true;
    },
    [cancelLocalSpeech, speechSupported]
  );

  const fallBackFromPack = useCallback((message?: string) => {
    activationEpochRef.current += 1;
    packClientRef.current?.cancel();
    void packClientRef.current?.deactivate();
    if (!mountedRef.current || !enabledRef.current) {
      return;
    }
    if (voiceRef.current) {
      setTransport("device");
      setSpeechStatus(
        "The branded AI voice could not load. Using a browser-reported local English voice; sound and platform privacy behaviour may vary."
      );
      return;
    }
    enabledRef.current = false;
    setEnabled(false);
    setTransport("visual");
    setSpeechStatus(
      message || "The branded AI voice is unavailable. Visual framing cues remain active."
    );
  }, []);

  const activatePack = useCallback(
    async (profile: VoiceProfileId, confirmationId?: CoachVoiceMessageId) => {
      cancelOwnedSpeech();
      const epoch = activationEpochRef.current;
      if (!mountedRef.current || !enabledRef.current || !pageVisibleRef.current) {
        return;
      }
      setTransport("loading");
      setSpeechStatus("Loading the British Maritime Command voice…");
      const client =
        packClientRef.current ??
        createCoachVoicePackClient({
          onError: (message) => {
            if (mountedRef.current && enabledRef.current) {
              fallBackFromPack(message);
            }
          }
        });
      packClientRef.current = client;

      try {
        // This call synchronously creates/resumes Web Audio before its first
        // await, preserving iOS user activation when invoked by the opt-in click.
        const activation = client.activate(profile);
        await activation;
        if (
          !mountedRef.current ||
          !enabledRef.current ||
          !pageVisibleRef.current ||
          packClientRef.current !== client ||
          activationEpochRef.current !== epoch
        ) {
          client.cancel();
          return;
        }
        setTransport("pack");
        setSpeechStatus("");
        if (confirmationId && client.speak(coachVoiceMessage(confirmationId))) {
          lastSpokenAtRef.current = performance.now();
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        if (
          mountedRef.current &&
          enabledRef.current &&
          packClientRef.current === client &&
          activationEpochRef.current === epoch
        ) {
          fallBackFromPack();
        }
      }
    },
    [cancelOwnedSpeech, fallBackFromPack]
  );

  const disableAfterDeviceError = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    setTransport("visual");
  }, []);

  const speak = useCallback(
    (message: CoachVoiceMessage) => {
      if (transport === "pack") {
        const spoken = packClientRef.current?.speak(message) ?? false;
        if (spoken) {
          lastSpokenAtRef.current = performance.now();
        } else {
          fallBackFromPack();
        }
        return spoken;
      }
      if (transport === "device") {
        return speakLocally(message, disableAfterDeviceError);
      }
      return false;
    }, [disableAfterDeviceError, fallBackFromPack, speakLocally, transport]
  );

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    selectedProfileRef.current = selectedProfile;
  }, [selectedProfile]);

  useEffect(() => {
    if (!speechSupported) {
      return;
    }
    const synthesis = window.speechSynthesis;
    const syncVoices = () => {
      const voices = synthesis.getVoices();
      const voice = chooseLocalVoice(voices);
      const hadVoice = voiceRef.current !== null;
      voiceRef.current = voice;
      if (packSupported || voice) {
        setAvailability("ready");
        return;
      }
      if (hadVoice) {
        discoveryTimedOutRef.current = true;
      }
      cancelLocalSpeech();
      if (transport === "device") {
        enabledRef.current = false;
        setEnabled(false);
        setTransport("visual");
      }
      setAvailability(
        voices.length > 0 || hadVoice || discoveryTimedOutRef.current
          ? "unavailable"
          : "loading"
      );
    };
    syncVoices();
    synthesis.addEventListener?.("voiceschanged", syncVoices);
    const discoveryTimeout = window.setTimeout(() => {
      if (!voiceRef.current && !packSupported) {
        discoveryTimedOutRef.current = true;
        enabledRef.current = false;
        setEnabled(false);
        setTransport("visual");
        setAvailability("unavailable");
      }
    }, VOICE_DISCOVERY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(discoveryTimeout);
      synthesis.removeEventListener?.("voiceschanged", syncVoices);
    };
  }, [cancelLocalSpeech, packSupported, speechSupported, transport]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      pageVisibleRef.current = visible;
      setPageVisible(visible);
      if (!visible) {
        cancelOwnedSpeech();
        void packClientRef.current?.deactivate();
        if (enabledRef.current) {
          setTransport("off");
        }
      }
    };
    const onPageHide = () => {
      pageVisibleRef.current = false;
      setPageVisible(false);
      cancelOwnedSpeech();
      void packClientRef.current?.deactivate();
      if (enabledRef.current) {
        setTransport("off");
      }
    };
    const onPageShow = () => {
      const visible = document.visibilityState !== "hidden";
      pageVisibleRef.current = visible;
      setPageVisible(visible);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [cancelOwnedSpeech]);

  useEffect(() => {
    const wasActive = previousSessionActiveRef.current;
    if (wasActive === sessionActive) {
      return;
    }
    previousSessionActiveRef.current = sessionActive;
    cancelOwnedSpeech();
    if (wasActive && !sessionActive && enabledRef.current) {
      setTransport("off");
      void packClientRef.current?.deactivate();
    }
    resetGuidanceState();
  }, [cancelOwnedSpeech, resetGuidanceState, sessionActive]);

  useEffect(() => {
    if (!enabled || !pageVisible || !sessionActive || transport !== "off") {
      return;
    }
    if (packSupported) {
      void activatePack(selectedProfileRef.current);
    } else if (voiceRef.current) {
      setTransport("device");
    }
  }, [activatePack, enabled, packSupported, pageVisible, sessionActive, transport]);

  useEffect(() => {
    let delay: number | null = null;
    let nextValue = motionCooldownActive;
    if (!automatic || !sessionActive) {
      delay = 0;
      nextValue = false;
    } else if (motionActive) {
      delay = 0;
      nextValue = true;
    } else if (motionCooldownActive) {
      delay = RECENT_MOTION_COOLDOWN_MS;
      nextValue = false;
    }
    if (delay === null || nextValue === motionCooldownActive) {
      return;
    }
    const handle = window.setTimeout(() => setMotionCooldownActive(nextValue), delay);
    return () => window.clearTimeout(handle);
  }, [automatic, motionActive, motionCooldownActive, sessionActive]);

  useEffect(() => {
    if (guidanceEvidenceValid) {
      return;
    }
    cancelOwnedSpeech();
    const handle = window.setTimeout(resetGuidanceState, 0);
    return () => window.clearTimeout(handle);
  }, [cancelOwnedSpeech, guidanceEvidenceValid, resetGuidanceState]);

  useEffect(() => {
    if (!guidanceEvidenceValid) {
      return;
    }
    if (
      cue.id === stableGuidance.cue.id &&
      stableGuidance.evidenceEpoch === guidanceEvidenceEpoch
    ) {
      return;
    }
    const delay =
      cue.id === "ready" || cue.id === "finding"
        ? READY_STABLE_MS
        : CORRECTION_STABLE_MS;
    const handle = window.setTimeout(
      () => setStableGuidance({ cue, evidenceEpoch: guidanceEvidenceEpoch }),
      delay
    );
    return () => window.clearTimeout(handle);
  }, [cue, guidanceEvidenceEpoch, guidanceEvidenceValid, stableGuidance]);

  useEffect(() => {
    if (rearmHandleRef.current !== null) {
      window.clearTimeout(rearmHandleRef.current);
      rearmHandleRef.current = null;
    }
    if (effectiveStableCue.id !== "ready") {
      rearmHandleRef.current = window.setTimeout(() => {
        readyArmedRef.current = true;
      }, READY_REARM_MS);
    }
    return () => {
      if (rearmHandleRef.current !== null) {
        window.clearTimeout(rearmHandleRef.current);
        rearmHandleRef.current = null;
      }
    };
  }, [effectiveStableCue.id]);

  useEffect(() => {
    const automaticActive =
      automatic &&
      guidanceEvidenceValid &&
      effectiveStableCue.id === cue.id &&
      !motionActive &&
      !motionCooldownActive;
    const transportReady = transport === "pack" || transport === "device";
    if (!enabled || !pageVisible) {
      cancelOwnedSpeech();
      return;
    }
    if (!transportReady) {
      return;
    }
    if (!automaticActive) {
      if (sessionActive) {
        cancelOwnedSpeech();
      }
      return;
    }

    let active = true;
    let handle = 0;
    const correction =
      effectiveStableCue.id !== "ready" && effectiveStableCue.id !== "finding";

    const announce = () => {
      if (!active) {
        return;
      }
      const elapsed = performance.now() - lastSpokenAtRef.current;
      if (elapsed < MIN_ANNOUNCEMENT_GAP_MS) {
        handle = window.setTimeout(announce, MIN_ANNOUNCEMENT_GAP_MS - elapsed);
        return;
      }
      if (effectiveStableCue.id === "ready") {
        if (readyArmedRef.current && speak(coachVoiceMessage("ready"))) {
          readyArmedRef.current = false;
        }
        return;
      }
      if (speak(coachVoiceMessage(effectiveStableCue.id)) && correction) {
        handle = window.setTimeout(announce, CORRECTION_REPEAT_MS);
      }
    };

    announce();
    return () => {
      active = false;
      window.clearTimeout(handle);
      cancelOwnedSpeech();
    };
  }, [
    automatic,
    cancelOwnedSpeech,
    cue.id,
    enabled,
    guidanceEvidenceValid,
    motionActive,
    motionCooldownActive,
    pageVisible,
    sessionActive,
    speak,
    effectiveStableCue,
    transport
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      enabledRef.current = false;
      cancelOwnedSpeech();
      const client = packClientRef.current;
      packClientRef.current = null;
      void client?.close();
    };
  }, [cancelOwnedSpeech]);

  const enable = useCallback(() => {
    if (availability !== "ready") {
      return;
    }
    setSpeechStatus("");
    resetGuidanceState();
    enabledRef.current = true;
    setEnabled(true);
    if (packSupported) {
      void activatePack(selectedProfileRef.current, "coach-on");
      return;
    }
    if (voiceRef.current) {
      setTransport("device");
      speakLocally(coachVoiceMessage("coach-on"), disableAfterDeviceError);
      return;
    }
    enabledRef.current = false;
    setEnabled(false);
    setTransport("visual");
  }, [
    activatePack,
    availability,
    disableAfterDeviceError,
    packSupported,
    resetGuidanceState,
    speakLocally
  ]);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    setTransport("off");
    setSpeechStatus("");
    cancelOwnedSpeech();
    void packClientRef.current?.deactivate();
    resetGuidanceState();
  }, [cancelOwnedSpeech, resetGuidanceState]);

  const toggle = useCallback(() => {
    if (enabledRef.current) {
      disable();
    } else {
      enable();
    }
  }, [disable, enable]);

  const selectProfile = useCallback(
    (profile: VoiceProfileId) => {
      if (selectedProfileRef.current === profile) {
        return;
      }
      if (enabledRef.current && transport === "device") {
        return;
      }
      selectedProfileRef.current = profile;
      setSelectedProfile(profile);
      cancelOwnedSpeech();
      resetGuidanceState();
      if (!enabledRef.current) {
        return;
      }
      const confirmationId =
        profile === "male-command"
          ? "male-command-selected"
          : "female-command-selected";
      if (packSupported) {
        void activatePack(profile, confirmationId);
      } else if (voiceRef.current) {
        setTransport("device");
        speakLocally(coachVoiceMessage(confirmationId), disableAfterDeviceError);
      }
    },
    [
      activatePack,
      cancelOwnedSpeech,
      disableAfterDeviceError,
      packSupported,
      resetGuidanceState,
      speakLocally,
      transport
    ]
  );

  const canRepeat =
    enabled &&
    (transport === "pack" || transport === "device") &&
    automatic &&
    guidanceEvidenceValid &&
    effectiveStableCue.id === cue.id &&
    !motionActive &&
    !motionCooldownActive &&
    pageVisible;

  const repeat = useCallback(() => {
    if (!canRepeat) {
      return;
    }
    setSpeechStatus("");
    speak(coachVoiceMessage(effectiveStableCue.id));
  }, [canRepeat, effectiveStableCue.id, speak]);

  return {
    availability,
    enabled,
    canRepeat,
    selectedProfile,
    transport,
    stableCue: effectiveStableCue,
    speechStatus,
    selectProfile,
    toggle,
    repeat,
    disable
  };
}
