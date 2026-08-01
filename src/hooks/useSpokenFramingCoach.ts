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
  createRealtimeVoiceClient,
  type RealtimeVoiceClient
} from "../lib/realtimeVoiceClient";

export type VoiceCoachAvailability = "loading" | "ready" | "unavailable";
export type VoiceCoachTransport =
  | "off"
  | "connecting"
  | "realtime"
  | "device"
  | "visual";

type SpokenFramingOptions = {
  cue: FramingCue;
  automatic: boolean;
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
  motionActive = false,
  sessionActive = false
}: SpokenFramingOptions) {
  const speechSupported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;
  const realtimeSupported =
    typeof window !== "undefined" &&
    typeof window.RTCPeerConnection === "function" &&
    typeof window.fetch === "function";
  const [availability, setAvailability] = useState<VoiceCoachAvailability>(
    realtimeSupported ? "ready" : speechSupported ? "loading" : "unavailable"
  );
  const [enabled, setEnabled] = useState(false);
  const [transport, setTransport] = useState<VoiceCoachTransport>("off");
  const [selectedProfile, setSelectedProfile] = useState<VoiceProfileId>(
    DEFAULT_COACH_VOICE_PROFILE_ID
  );
  const [stableCue, setStableCue] = useState<FramingCue>(FRAMING_CUES.finding);
  const [speechStatus, setSpeechStatus] = useState("");
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  const [motionCooldownActive, setMotionCooldownActive] = useState(false);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const realtimeClientRef = useRef<RealtimeVoiceClient | null>(null);
  const closingRealtimeRef = useRef<Promise<void>>(Promise.resolve());
  const connectionEpochRef = useRef(0);
  const enabledRef = useRef(false);
  const selectedProfileRef = useRef<VoiceProfileId>(DEFAULT_COACH_VOICE_PROFILE_ID);
  const pageVisibleRef = useRef(pageVisible);
  const realtimeSessionAllowedRef = useRef(true);
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
    realtimeClientRef.current?.cancel();
    cancelLocalSpeech();
  }, [cancelLocalSpeech]);

  const closeRealtime = useCallback((): Promise<void> => {
    connectionEpochRef.current += 1;
    const client = realtimeClientRef.current;
    realtimeClientRef.current = null;
    if (client) {
      try {
        closingRealtimeRef.current = Promise.resolve(client.close()).catch(() => undefined);
      } catch {
        closingRealtimeRef.current = Promise.resolve();
      }
    }
    return closingRealtimeRef.current;
  }, []);

  const resetGuidanceState = useCallback(() => {
    setStableCue(FRAMING_CUES.finding);
    readyArmedRef.current = true;
    if (rearmHandleRef.current !== null) {
      window.clearTimeout(rearmHandleRef.current);
      rearmHandleRef.current = null;
    }
  }, []);

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

  const fallBackFromRealtime = useCallback((message?: string) => {
    void closeRealtime();
    if (!mountedRef.current || !enabledRef.current) {
      return;
    }
    if (voiceRef.current) {
      setTransport("device");
      setSpeechStatus(
        "OpenAI Realtime is unavailable. Using a private on-device English voice; tone may vary."
      );
      return;
    }
    enabledRef.current = false;
    setEnabled(false);
    setTransport("visual");
    setSpeechStatus(
      message || "AI voice is unavailable. Visual framing cues remain active."
    );
  }, [closeRealtime]);

  const connectRealtime = useCallback(
    async (profile: VoiceProfileId, confirmationId?: CoachVoiceMessageId) => {
      const pendingClose = closeRealtime();
      const epoch = connectionEpochRef.current;
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        !pageVisibleRef.current ||
        !realtimeSessionAllowedRef.current
      ) {
        return;
      }
      setTransport("connecting");
      setSpeechStatus("Connecting the AI voice coach securely…");

      await pendingClose;
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        !pageVisibleRef.current ||
        !realtimeSessionAllowedRef.current ||
        connectionEpochRef.current !== epoch
      ) {
        return;
      }

      const client: RealtimeVoiceClient = createRealtimeVoiceClient({
        onError: (message) => {
          if (
            mountedRef.current &&
            enabledRef.current &&
            realtimeClientRef.current === client &&
            connectionEpochRef.current === epoch
          ) {
            fallBackFromRealtime(message);
          }
        }
      });
      realtimeClientRef.current = client;

      try {
        await client.connect(profile);
        if (
          !mountedRef.current ||
          !enabledRef.current ||
          realtimeClientRef.current !== client ||
          connectionEpochRef.current !== epoch
        ) {
          void client.close();
          return;
        }
        setTransport("realtime");
        setSpeechStatus("");
        if (confirmationId && client.speak(coachVoiceMessage(confirmationId))) {
          lastSpokenAtRef.current = performance.now();
        }
      } catch {
        if (
          mountedRef.current &&
          enabledRef.current &&
          realtimeClientRef.current === client &&
          connectionEpochRef.current === epoch
        ) {
          fallBackFromRealtime();
        }
      }
    },
    [closeRealtime, fallBackFromRealtime]
  );

  const disableAfterDeviceError = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    setTransport("visual");
  }, []);

  const speak = useCallback(
    (message: CoachVoiceMessage) => {
      if (transport === "realtime") {
        const spoken = realtimeClientRef.current?.speak(message) ?? false;
        if (spoken) {
          lastSpokenAtRef.current = performance.now();
        }
        return spoken;
      }
      if (transport === "device") {
        return speakLocally(message, disableAfterDeviceError);
      }
      return false;
    },
    [disableAfterDeviceError, speakLocally, transport]
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
      if (realtimeSupported || voice) {
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
      if (!voiceRef.current && !realtimeSupported) {
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
  }, [cancelLocalSpeech, realtimeSupported, speechSupported, transport]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      pageVisibleRef.current = visible;
      setPageVisible(visible);
      if (!visible) {
        cancelOwnedSpeech();
        void closeRealtime();
        if (enabledRef.current) {
          setTransport("off");
        }
      }
    };
    const onPageHide = () => {
      pageVisibleRef.current = false;
      setPageVisible(false);
      cancelOwnedSpeech();
      void closeRealtime();
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
  }, [cancelOwnedSpeech, closeRealtime]);

  useEffect(() => {
    const wasActive = previousSessionActiveRef.current;
    if (wasActive === sessionActive) {
      return;
    }
    previousSessionActiveRef.current = sessionActive;
    cancelOwnedSpeech();
    if (wasActive && !sessionActive) {
      realtimeSessionAllowedRef.current = false;
      void closeRealtime();
      if (enabledRef.current) {
        setTransport("off");
      }
    } else if (sessionActive) {
      realtimeSessionAllowedRef.current = true;
    }
    resetGuidanceState();
  }, [cancelOwnedSpeech, closeRealtime, resetGuidanceState, sessionActive]);

  useEffect(() => {
    if (!enabled || !pageVisible || !sessionActive || transport !== "off") {
      return;
    }
    if (realtimeSupported) {
      void connectRealtime(selectedProfileRef.current);
    } else if (voiceRef.current) {
      setTransport("device");
    }
  }, [connectRealtime, enabled, pageVisible, realtimeSupported, sessionActive, transport]);

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
    if (cue.id === stableCue.id) {
      return;
    }
    const delay = cue.id === "ready" || cue.id === "finding"
      ? READY_STABLE_MS
      : CORRECTION_STABLE_MS;
    const handle = window.setTimeout(() => setStableCue(cue), delay);
    return () => window.clearTimeout(handle);
  }, [cue, stableCue.id]);

  useEffect(() => {
    if (rearmHandleRef.current !== null) {
      window.clearTimeout(rearmHandleRef.current);
      rearmHandleRef.current = null;
    }
    if (stableCue.id !== "ready") {
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
  }, [stableCue.id]);

  useEffect(() => {
    const automaticActive = automatic && !motionActive && !motionCooldownActive;
    const transportReady = transport === "realtime" || transport === "device";
    if (!enabled || !transportReady || !pageVisible) {
      cancelOwnedSpeech();
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
    const correction = stableCue.id !== "ready" && stableCue.id !== "finding";

    const announce = () => {
      if (!active) {
        return;
      }
      const elapsed = performance.now() - lastSpokenAtRef.current;
      if (elapsed < MIN_ANNOUNCEMENT_GAP_MS) {
        handle = window.setTimeout(announce, MIN_ANNOUNCEMENT_GAP_MS - elapsed);
        return;
      }
      if (stableCue.id === "ready") {
        if (readyArmedRef.current && speak(coachVoiceMessage("ready"))) {
          readyArmedRef.current = false;
        }
        return;
      }
      if (speak(coachVoiceMessage(stableCue.id)) && correction) {
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
    enabled,
    motionActive,
    motionCooldownActive,
    pageVisible,
    sessionActive,
    speak,
    stableCue,
    transport
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      enabledRef.current = false;
      cancelOwnedSpeech();
      void closeRealtime();
    };
  }, [cancelOwnedSpeech, closeRealtime]);

  const enable = useCallback(() => {
    if (availability !== "ready") {
      return;
    }
    setSpeechStatus("");
    resetGuidanceState();
    enabledRef.current = true;
    setEnabled(true);
    if (realtimeSupported) {
      void connectRealtime(selectedProfileRef.current, "coach-on");
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
    availability,
    connectRealtime,
    disableAfterDeviceError,
    realtimeSupported,
    resetGuidanceState,
    speakLocally
  ]);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    setTransport("off");
    setSpeechStatus("");
    cancelOwnedSpeech();
    void closeRealtime();
    resetGuidanceState();
  }, [cancelOwnedSpeech, closeRealtime, resetGuidanceState]);

  const toggle = useCallback(() => {
    if (enabledRef.current) {
      disable();
    } else {
      enable();
    }
  }, [disable, enable]);

  const selectProfile = useCallback((profile: VoiceProfileId) => {
    if (selectedProfileRef.current === profile) {
      return;
    }
    selectedProfileRef.current = profile;
    setSelectedProfile(profile);
    cancelOwnedSpeech();
    resetGuidanceState();
    if (!enabledRef.current) {
      return;
    }
    const confirmationId = profile === "male-command"
      ? "male-command-selected"
      : "female-command-selected";
    if (realtimeSupported) {
      void connectRealtime(profile, confirmationId);
    } else if (voiceRef.current) {
      setTransport("device");
      speakLocally(coachVoiceMessage(confirmationId), disableAfterDeviceError);
    }
  }, [
    cancelOwnedSpeech,
    connectRealtime,
    disableAfterDeviceError,
    realtimeSupported,
    resetGuidanceState,
    speakLocally
  ]);

  const canRepeat =
    enabled &&
    (transport === "realtime" || transport === "device") &&
    automatic &&
    !motionActive &&
    !motionCooldownActive &&
    pageVisible;

  const repeat = useCallback(() => {
    if (!canRepeat) {
      return;
    }
    setSpeechStatus("");
    speak(coachVoiceMessage(stableCue.id));
  }, [canRepeat, speak, stableCue.id]);

  return {
    availability,
    enabled,
    canRepeat,
    selectedProfile,
    transport,
    stableCue,
    speechStatus,
    selectProfile,
    toggle,
    repeat,
    disable
  };
}
