import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpokenFramingCoach } from "../useSpokenFramingCoach";
import { FRAMING_CUES } from "../../lib/framingCoach";

const packFactory = vi.hoisted(() => ({
  create: vi.fn(),
  supports: vi.fn()
}));

vi.mock("../../lib/coachVoicePackClient", () => ({
  createCoachVoicePackClient: packFactory.create,
  supportsCoachVoicePack: packFactory.supports
}));

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function packClient() {
  return {
    activate: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockReturnValue(true),
    cancel: vi.fn(),
    deactivate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

class UtteranceStub {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function voice({
  name,
  lang,
  localService
}: {
  name: string;
  lang: string;
  localService: boolean;
}) {
  return {
    default: false,
    lang,
    localService,
    name,
    voiceURI: name
  } as SpeechSynthesisVoice;
}

function speechHarness(initialVoices: SpeechSynthesisVoice[]) {
  let voices = initialVoices;
  const listeners = new Set<EventListener>();
  const synthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "voiceschanged") {
        listeners.add(listener);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "voiceschanged") {
        listeners.delete(listener);
      }
    })
  } as unknown as SpeechSynthesis;
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: synthesis
  });
  vi.stubGlobal("SpeechSynthesisUtterance", UtteranceStub);
  return {
    synthesis,
    setVoices(next: SpeechSynthesisVoice[]) {
      voices = next;
      listeners.forEach((listener) => listener(new Event("voiceschanged")));
    }
  };
}

describe("useSpokenFramingCoach", () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    packFactory.create.mockReset();
    packFactory.supports.mockReset().mockReturnValue(false);
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "speechSynthesis");
  });

  const advance = (milliseconds: number) => {
    now += milliseconds;
    act(() => vi.advanceTimersByTime(milliseconds));
  };

  it("loads the selected branded pack only after explicit opt-in", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    packFactory.create.mockReturnValue(client);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({
        cue: FRAMING_CUES.finding,
        automatic: false,
        sessionActive: false
      })
    );

    expect(result.current.availability).toBe("ready");
    expect(packFactory.create).not.toHaveBeenCalled();
    act(() => result.current.toggle());
    expect(client.activate).toHaveBeenCalledWith("female-command");
    expect(result.current.transport).toBe("loading");

    await act(async () => Promise.resolve());
    expect(result.current.transport).toBe("pack");
    expect(client.speak).toHaveBeenCalledWith({
      id: "coach-on",
      speech: "Voice framing coach on."
    });
  });

  it("uses a profile selected before opt-in and announces later switches", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    packFactory.create.mockReturnValue(client);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.selectProfile("male-command"));
    expect(packFactory.create).not.toHaveBeenCalled();
    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    expect(client.activate).toHaveBeenCalledWith("male-command");

    act(() => result.current.selectProfile("female-command"));
    await act(async () => Promise.resolve());
    expect(client.activate).toHaveBeenLastCalledWith("female-command");
    expect(client.speak).toHaveBeenLastCalledWith({
      id: "female-command-selected",
      speech: "Female British coach selected."
    });
  });

  it("does not let a stale profile activation win a rapid switch", async () => {
    packFactory.supports.mockReturnValue(true);
    const female = deferred<void>();
    const male = deferred<void>();
    const client = packClient();
    client.activate.mockImplementation((profile) =>
      profile === "female-command" ? female.promise : male.promise
    );
    packFactory.create.mockReturnValue(client);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.toggle());
    act(() => result.current.selectProfile("male-command"));
    await act(async () => {
      male.resolve(undefined);
      await male.promise;
    });
    expect(result.current.transport).toBe("pack");
    expect(result.current.selectedProfile).toBe("male-command");
    expect(client.speak).toHaveBeenCalledWith({
      id: "male-command-selected",
      speech: "Male British coach selected."
    });

    await act(async () => {
      female.resolve(undefined);
      await female.promise;
    });
    expect(result.current.selectedProfile).toBe("male-command");
    expect(client.speak).not.toHaveBeenCalledWith({
      id: "coach-on",
      speech: "Voice framing coach on."
    });
  });

  it("stays off when disabled during a pending activation", async () => {
    packFactory.supports.mockReturnValue(true);
    const activation = deferred<void>();
    const client = packClient();
    client.activate.mockReturnValue(activation.promise);
    packFactory.create.mockReturnValue(client);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(result.current.transport).toBe("off");
    expect(client.cancel).toHaveBeenCalled();

    await act(async () => {
      activation.resolve(undefined);
      await activation.promise;
    });
    expect(result.current.transport).toBe("off");
    expect(client.speak).not.toHaveBeenCalled();
  });

  it("cancels on pagehide and reactivates an active session on pageshow", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    packFactory.create.mockReturnValue(client);
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({
        cue: FRAMING_CUES.finding,
        automatic: false,
        sessionActive: true
      })
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    client.cancel.mockClear();
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(client.cancel).toHaveBeenCalled();
    expect(client.deactivate).toHaveBeenCalled();
    expect(result.current.transport).toBe("off");

    visibility = "visible";
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(async () => Promise.resolve());
    expect(client.activate).toHaveBeenCalledTimes(2);
    expect(result.current.transport).toBe("pack");
  });

  it("closes the one owned pack client only on unmount", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    packFactory.create.mockReturnValue(client);
    const { result, unmount } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    act(() => result.current.toggle());
    expect(client.close).not.toHaveBeenCalled();
    expect(client.deactivate).toHaveBeenCalled();
    unmount();
    expect(client.cancel).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("remains activatable after the StrictMode effect cleanup cycle", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    packFactory.create.mockReturnValue(client);
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(
      () => useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false }),
      { wrapper }
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    expect(result.current.transport).toBe("pack");
    expect(client.close).not.toHaveBeenCalled();
  });

  it("falls back to a browser-reported local voice when pack activation fails", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    client.activate.mockRejectedValue(new Error("network"));
    packFactory.create.mockReturnValue(client);
    speechHarness([voice({ name: "Local", lang: "en-GB", localService: true })]);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    expect(result.current.enabled).toBe(true);
    expect(result.current.transport).toBe("device");
    expect(result.current.speechStatus).toMatch(/browser-reported local English voice/i);
    expect(result.current.speechStatus).not.toMatch(/private/i);
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.deactivate).not.toHaveBeenCalled();

    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(packFactory.create).toHaveBeenCalledOnce();
    expect(client.activate).toHaveBeenCalledOnce();
    expect(result.current.transport).toBe("device");
  });

  it("circuit-breaks a timed-out pack for the page even while close is pending", async () => {
    packFactory.supports.mockReturnValue(true);
    const closing = deferred<void>();
    const failedClient = packClient();
    failedClient.activate.mockRejectedValue(new Error("Voice pack activation timed out."));
    failedClient.close.mockReturnValue(closing.promise);
    packFactory.create.mockReturnValue(failedClient);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({
        cue: FRAMING_CUES.finding,
        automatic: false,
        sessionActive: true
      })
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());

    expect(result.current.enabled).toBe(false);
    expect(result.current.transport).toBe("visual");
    expect(result.current.availability).toBe("unavailable");
    expect(failedClient.close).toHaveBeenCalledOnce();
    expect(packFactory.create).toHaveBeenCalledOnce();

    advance(60_000);
    await act(async () => Promise.resolve());
    expect(failedClient.activate).toHaveBeenCalledOnce();
    expect(packFactory.create).toHaveBeenCalledOnce();

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    expect(packFactory.create).toHaveBeenCalledOnce();
    expect(failedClient.activate).toHaveBeenCalledOnce();
    expect(result.current.transport).toBe("visual");

    await act(async () => {
      closing.reject(new Error("close failed"));
      await Promise.resolve();
    });
    expect(packFactory.create).toHaveBeenCalledOnce();
    expect(result.current.transport).toBe("visual");
  });

  it("does not retire a client when an older activation fails after a newer one wins", async () => {
    packFactory.supports.mockReturnValue(true);
    const female = deferred<void>();
    const client = packClient();
    client.activate.mockImplementation((profile) =>
      profile === "female-command" ? female.promise : Promise.resolve()
    );
    packFactory.create.mockReturnValue(client);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.toggle());
    act(() => result.current.selectProfile("male-command"));
    await act(async () => Promise.resolve());
    expect(result.current.transport).toBe("pack");
    expect(result.current.selectedProfile).toBe("male-command");

    await act(async () => {
      female.reject(new Error("stale activation failed"));
      await female.promise.catch(() => undefined);
    });
    expect(client.close).not.toHaveBeenCalled();
    expect(result.current.transport).toBe("pack");
    expect(result.current.selectedProfile).toBe("male-command");
  });

  it("does not pretend that device fallback follows branded profile switches", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );

    act(() => result.current.toggle());
    expect(result.current.transport).toBe("device");
    expect(result.current.selectedProfile).toBe("female-command");
    act(() => result.current.selectProfile("male-command"));
    expect(result.current.selectedProfile).toBe("female-command");
    expect(synthesis.speak).toHaveBeenCalledOnce();
  });

  it("keeps visual guidance when neither branded nor local speech can play", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    client.activate.mockRejectedValue(new Error("network"));
    packFactory.create.mockReturnValue(client);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.ready, automatic: true })
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    expect(result.current.enabled).toBe(false);
    expect(result.current.transport).toBe("visual");
    expect(result.current.speechStatus).toMatch(/visual framing cues remain active/i);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses only a local English fallback and debounces repeated corrections", () => {
    const remote = voice({ name: "Remote English", lang: "en-GB", localService: false });
    const local = voice({ name: "Local English", lang: "en-GB", localService: true });
    const { synthesis } = speechHarness([remote, local]);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({
        cue: FRAMING_CUES["move-right"],
        automatic: true,
        sessionActive: true
      })
    );

    expect(result.current.availability).toBe("ready");
    act(() => result.current.toggle());
    expect(synthesis.speak).toHaveBeenCalledOnce();
    expect((vi.mocked(synthesis.speak).mock.calls[0][0] as SpeechSynthesisUtterance).voice).toBe(local);

    advance(799);
    expect(result.current.stableCue.id).toBe("finding");
    advance(1);
    expect(result.current.stableCue.id).toBe("move-right");
    advance(2_200);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
    expect((vi.mocked(synthesis.speak).mock.calls[1][0] as SpeechSynthesisUtterance).text).toBe(
      "Move a little right in the frame."
    );
    advance(7_000);
    expect(synthesis.speak).toHaveBeenCalledTimes(3);
  });

  it("cancels queued automatic speech immediately when live pose evidence becomes unsafe", async () => {
    packFactory.supports.mockReturnValue(true);
    const client = packClient();
    packFactory.create.mockReturnValue(client);
    const { result, rerender } = renderHook(
      ({ guidanceEvidenceEpoch, guidanceEvidenceValid }) =>
        useSpokenFramingCoach({
          cue: FRAMING_CUES["move-right"],
          automatic: true,
          guidanceEvidenceEpoch,
          guidanceEvidenceValid,
          sessionActive: true
        }),
      { initialProps: { guidanceEvidenceEpoch: 0, guidanceEvidenceValid: true } }
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    expect(client.speak).toHaveBeenCalledWith({
      id: "coach-on",
      speech: "Voice framing coach on."
    });
    client.cancel.mockClear();

    advance(800);
    expect(result.current.stableCue.id).toBe("move-right");
    rerender({ guidanceEvidenceEpoch: 1, guidanceEvidenceValid: false });

    expect(client.cancel).toHaveBeenCalled();
    expect(result.current.stableCue.id).toBe("finding");
    expect(result.current.canRepeat).toBe(false);
    advance(7_000);
    expect(client.speak).not.toHaveBeenCalledWith({
      id: "move-right",
      speech: "Move a little right in the frame."
    });

    rerender({ guidanceEvidenceEpoch: 1, guidanceEvidenceValid: true });
    advance(800);
    expect(client.speak).toHaveBeenCalledWith({
      id: "move-right",
      speech: "Move a little right in the frame."
    });
  });

  it("refuses remote-only device speech while preserving visual cues", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Remote", lang: "en-GB", localService: false })
    ]);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.ready, automatic: true })
    );

    expect(result.current.availability).toBe("unavailable");
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(synthesis.speak).not.toHaveBeenCalled();
    advance(1_200);
    expect(result.current.stableCue.id).toBe("ready");
  });

  it("waits for asynchronous local voice discovery when Web Audio is unavailable", () => {
    const harness = speechHarness([]);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );
    expect(result.current.availability).toBe("loading");

    act(() =>
      harness.setVoices([
        voice({ name: "System voice", lang: "en-US", localService: true })
      ])
    );
    expect(result.current.availability).toBe("ready");
  });

  it("does not cancel another feature's device speech before opt-in", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    renderHook(() =>
      useSpokenFramingCoach({ cue: FRAMING_CUES.finding, automatic: false })
    );
    expect(synthesis.cancel).not.toHaveBeenCalled();
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("resets ready guidance across workout sessions", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result, rerender } = renderHook(
      ({ automatic, sessionActive }) =>
        useSpokenFramingCoach({ cue: FRAMING_CUES.ready, automatic, sessionActive }),
      { initialProps: { automatic: true, sessionActive: true } }
    );

    act(() => result.current.toggle());
    (vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub).onend?.();
    advance(1_200);
    advance(1_800);
    expect(
      vi.mocked(synthesis.speak).mock.calls.filter(
        ([utterance]) => (utterance as SpeechSynthesisUtterance).text === FRAMING_CUES.ready.speech
      )
    ).toHaveLength(1);

    rerender({ automatic: false, sessionActive: false });
    expect(result.current.stableCue.id).toBe("finding");
    rerender({ automatic: true, sessionActive: true });
    advance(1_200);
    advance(1_800);
    expect(
      vi.mocked(synthesis.speak).mock.calls.filter(
        ([utterance]) => (utterance as SpeechSynthesisUtterance).text === FRAMING_CUES.ready.speech
      )
    ).toHaveLength(2);
  });

  it("suppresses framing speech during motion and its tracking cooldown", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result, rerender } = renderHook(
      ({ motionActive }) =>
        useSpokenFramingCoach({
          cue: FRAMING_CUES["move-right"],
          automatic: true,
          motionActive,
          sessionActive: true
        }),
      { initialProps: { motionActive: false } }
    );

    act(() => result.current.toggle());
    (vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub).onend?.();
    advance(800);
    advance(2_200);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);

    rerender({ motionActive: true });
    advance(0);
    rerender({ motionActive: false });
    expect(result.current.canRepeat).toBe(false);
    advance(3_999);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
    advance(1);
    expect(synthesis.speak).toHaveBeenCalledTimes(3);
    expect(result.current.canRepeat).toBe(true);
  });

  it("disables retries after a real local synthesis failure", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result } = renderHook(() =>
      useSpokenFramingCoach({
        cue: FRAMING_CUES["move-left"],
        automatic: true,
        sessionActive: true
      })
    );

    act(() => result.current.toggle());
    (vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub).onend?.();
    advance(800);
    advance(2_200);
    const correction = vi.mocked(synthesis.speak).mock.calls[1][0] as unknown as UtteranceStub;
    expect(correction.onerror).toBeTypeOf("function");
    act(() => correction.onerror?.({ error: "synthesis-failed" }));
    expect(result.current.enabled).toBe(false);
    expect(result.current.speechStatus).toMatch(/visual framing cues remain active/i);
    advance(7_000);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
  });
});
