import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpokenFramingCoach } from "../useSpokenFramingCoach";
import { FRAMING_CUES } from "../../lib/framingCoach";

const realtimeFactory = vi.hoisted(() => ({
  create: vi.fn()
}));

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

vi.mock("../../lib/realtimeVoiceClient", () => ({
  createRealtimeVoiceClient: realtimeFactory.create
}));

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
    realtimeFactory.create.mockReset();
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

  it("is opt-in, selects a local English voice, and debounces repeated corrections", () => {
    const remote = voice({ name: "Remote English", lang: "en-GB", localService: false });
    const local = voice({ name: "Local English", lang: "en-GB", localService: true });
    const { synthesis } = speechHarness([remote, local]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES["move-right"],
      automatic: true
    }));

    expect(result.current.availability).toBe("ready");
    expect(result.current.enabled).toBe(false);
    expect(synthesis.speak).not.toHaveBeenCalled();

    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(true);
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
    advance(6_999);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
    advance(1);
    expect(synthesis.speak).toHaveBeenCalledTimes(3);
  });

  it("refuses remote-only speech services while preserving visual cues", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Remote", lang: "en-GB", localService: false })
    ]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.ready,
      automatic: true
    }));

    expect(result.current.availability).toBe("unavailable");
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(synthesis.speak).not.toHaveBeenCalled();
    advance(1_200);
    expect(result.current.stableCue.id).toBe("ready");
  });

  it("does not cancel another page feature's speech before opt-in", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);

    renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));

    expect(synthesis.cancel).not.toHaveBeenCalled();
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("does not cancel the explicit enable confirmation before a session starts", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false,
      sessionActive: false
    }));
    vi.mocked(synthesis.cancel).mockClear();

    act(() => result.current.toggle());

    expect(result.current.enabled).toBe(true);
    expect(synthesis.speak).toHaveBeenCalledOnce();
    expect(synthesis.cancel).not.toHaveBeenCalled();
  });

  it("waits for asynchronously discovered on-device voices", () => {
    const harness = speechHarness([]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));
    expect(result.current.availability).toBe("loading");

    act(() => harness.setVoices([
      voice({ name: "System voice", lang: "en-US", localService: true })
    ]));
    expect(result.current.availability).toBe("ready");
  });

  it("does not commit rapidly flapping left and right directions", () => {
    speechHarness([voice({ name: "Local", lang: "en-GB", localService: true })]);
    const { result, rerender } = renderHook(
      ({ cue }) => useSpokenFramingCoach({ cue, automatic: false }),
      { initialProps: { cue: FRAMING_CUES["move-left"] } }
    );

    advance(400);
    rerender({ cue: FRAMING_CUES["move-right"] });
    advance(400);
    rerender({ cue: FRAMING_CUES["move-left"] });
    advance(799);
    expect(result.current.stableCue.id).toBe("finding");
    advance(1);
    expect(result.current.stableCue.id).toBe("move-left");
  });

  it("cancels only owned speech when coaching is suppressed, disabled, or unmounted", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result, rerender, unmount } = renderHook(
      ({ automatic, sessionActive }) => useSpokenFramingCoach({
        cue: FRAMING_CUES["step-back"],
        automatic,
        sessionActive
      }),
      { initialProps: { automatic: false, sessionActive: false } }
    );
    act(() => result.current.toggle());
    vi.mocked(synthesis.cancel).mockClear();

    const confirmation = vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub;
    const cancellationHandler = confirmation.onerror;
    rerender({ automatic: false, sessionActive: true });
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    act(() => cancellationHandler?.({ error: "canceled" }));
    expect(result.current.enabled).toBe(true);
    expect(result.current.speechStatus).toBe("");

    vi.mocked(synthesis.cancel).mockClear();
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(synthesis.cancel).not.toHaveBeenCalled();

    rerender({ automatic: false, sessionActive: false });
    act(() => result.current.toggle());
    vi.mocked(synthesis.cancel).mockClear();
    unmount();
    expect(synthesis.cancel).toHaveBeenCalledOnce();
  });

  it("drops an unavailable or non-English local voice without a remote fallback", () => {
    const harness = speechHarness([
      voice({ name: "English", lang: "en-GB", localService: true }),
      voice({ name: "French", lang: "fr-FR", localService: true })
    ]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));

    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(true);
    act(() => harness.setVoices([]));
    expect(result.current.availability).toBe("unavailable");
    expect(result.current.enabled).toBe(false);

    act(() => harness.setVoices([
      voice({ name: "French", lang: "fr-FR", localService: true })
    ]));
    expect(result.current.availability).toBe("unavailable");
  });

  it("resets debounced guidance and ready announcements across sessions", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result, rerender } = renderHook(
      ({ automatic, sessionActive }) => useSpokenFramingCoach({
        cue: FRAMING_CUES.ready,
        automatic,
        sessionActive
      }),
      { initialProps: { automatic: true, sessionActive: true } }
    );

    act(() => result.current.toggle());
    (vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub).onend?.();
    advance(1_200);
    advance(1_800);
    expect(vi.mocked(synthesis.speak).mock.calls.at(-1)?.[0]).toMatchObject({
      text: FRAMING_CUES.ready.speech
    });

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

  it("suppresses framing speech through an active rep and tracking-loss cooldown", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result, rerender } = renderHook(
      ({ motionActive }) => useSpokenFramingCoach({
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

  it("disables automatic retries after a synthesis failure", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES["move-left"],
      automatic: true,
      sessionActive: true
    }));

    act(() => result.current.toggle());
    (vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub).onend?.();
    advance(800);
    advance(2_200);
    const correction = vi.mocked(synthesis.speak).mock.calls[1][0] as unknown as UtteranceStub;
    act(() => correction.onerror?.({ error: "synthesis-failed" }));
    expect(result.current.enabled).toBe(false);
    expect(result.current.speechStatus).toMatch(/visual framing cues remain active/i);
    advance(7_000);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
  });

  it("fails safely when the device voice rejects an utterance", () => {
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));

    act(() => result.current.toggle());
    const utterance = vi.mocked(synthesis.speak).mock.calls[0][0] as unknown as UtteranceStub;
    act(() => utterance.onerror?.({ error: "canceled" }));
    expect(result.current.enabled).toBe(true);
    expect(result.current.speechStatus).toBe("");

    act(() => utterance.onerror?.({ error: "synthesis-failed" }));
    expect(result.current.enabled).toBe(false);
    expect(result.current.speechStatus).toMatch(/visual framing cues remain active/i);
  });

  it("connects the selected profile over Realtime only after explicit opt-in", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const client = {
      cancel: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create.mockReturnValue(client);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));

    expect(result.current.availability).toBe("ready");
    expect(client.connect).not.toHaveBeenCalled();

    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(true);
    expect(result.current.transport).toBe("connecting");
    await act(async () => Promise.resolve());

    expect(client.connect).toHaveBeenCalledWith("female-command");
    expect(client.speak).toHaveBeenCalledWith({
      id: "coach-on",
      speech: "Voice framing coach on."
    });
    expect(result.current.transport).toBe("realtime");
  });

  it("remains connectable after the StrictMode effect cleanup cycle", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const client = {
      cancel: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create.mockReturnValue(client);
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }), { wrapper });

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());

    expect(client.connect).toHaveBeenCalledWith("female-command");
    expect(result.current.enabled).toBe(true);
    expect(result.current.transport).toBe("realtime");
  });

  it("closes the old Realtime session before switching voice profiles", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const closing = deferred<void>();
    const femaleClient = {
      cancel: vi.fn(),
      close: vi.fn(() => closing.promise),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    const maleClient = {
      cancel: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create
      .mockReturnValueOnce(femaleClient)
      .mockReturnValueOnce(maleClient);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    femaleClient.cancel.mockClear();
    femaleClient.close.mockClear();
    act(() => result.current.selectProfile("male-command"));
    await act(async () => Promise.resolve());

    expect(femaleClient.cancel).toHaveBeenCalledOnce();
    expect(femaleClient.close).toHaveBeenCalledOnce();
    expect(femaleClient.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      femaleClient.close.mock.invocationCallOrder[0]
    );
    expect(realtimeFactory.create).toHaveBeenCalledOnce();
    expect(maleClient.connect).not.toHaveBeenCalled();
    expect(result.current.transport).toBe("connecting");

    await act(async () => {
      closing.resolve(undefined);
      await closing.promise;
    });

    expect(maleClient.connect).toHaveBeenCalledWith("male-command");
    expect(maleClient.speak).toHaveBeenCalledWith({
      id: "male-command-selected",
      speech: "Male British coach selected."
    });
    expect(result.current.selectedProfile).toBe("male-command");
    expect(result.current.transport).toBe("realtime");
  });

  it("cancels and closes Realtime immediately when the coach is disabled", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const closing = deferred<void>();
    const client = {
      cancel: vi.fn(),
      close: vi.fn(() => closing.promise),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create.mockReturnValue(client);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false,
      sessionActive: true
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    client.cancel.mockClear();
    client.close.mockClear();

    act(() => result.current.disable());

    expect(client.cancel).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      client.close.mock.invocationCallOrder[0]
    );
    expect(result.current.enabled).toBe(false);
    expect(result.current.transport).toBe("off");

    await act(async () => {
      closing.resolve(undefined);
      await closing.promise;
    });
    expect(realtimeFactory.create).toHaveBeenCalledOnce();
  });

  it("finishes disabling when a Realtime client throws synchronously during close", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const client = {
      cancel: vi.fn(),
      close: vi.fn(() => {
        throw new Error("faulty client close");
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create.mockReturnValue(client);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false,
      sessionActive: true
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());

    expect(() => act(() => result.current.disable())).not.toThrow();
    expect(client.cancel).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(result.current.enabled).toBe(false);
    expect(result.current.transport).toBe("off");
  });

  it("closes on session end and waits for bounded cleanup before a session restart", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const closing = deferred<void>();
    const firstClient = {
      cancel: vi.fn(),
      close: vi.fn(() => closing.promise),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    const nextClient = {
      cancel: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(nextClient);
    const { result, rerender } = renderHook(
      ({ sessionActive }) => useSpokenFramingCoach({
        cue: FRAMING_CUES.finding,
        automatic: false,
        sessionActive
      }),
      { initialProps: { sessionActive: true } }
    );

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    firstClient.cancel.mockClear();
    firstClient.close.mockClear();

    rerender({ sessionActive: false });

    expect(firstClient.cancel).toHaveBeenCalled();
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(firstClient.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      firstClient.close.mock.invocationCallOrder[0]
    );
    expect(result.current.transport).toBe("off");
    expect(realtimeFactory.create).toHaveBeenCalledOnce();

    act(() => result.current.selectProfile("male-command"));
    await act(async () => Promise.resolve());
    expect(result.current.selectedProfile).toBe("male-command");
    expect(result.current.transport).toBe("off");
    expect(realtimeFactory.create).toHaveBeenCalledOnce();

    rerender({ sessionActive: true });
    await act(async () => Promise.resolve());
    expect(result.current.transport).toBe("connecting");
    expect(realtimeFactory.create).toHaveBeenCalledOnce();

    await act(async () => {
      closing.resolve(undefined);
      await closing.promise;
    });

    expect(realtimeFactory.create).toHaveBeenCalledTimes(2);
    expect(nextClient.connect).toHaveBeenCalledWith("male-command");
    expect(result.current.transport).toBe("realtime");
  });

  it("closes on visibility loss and waits for cleanup before reconnecting", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const closing = deferred<void>();
    const firstClient = {
      cancel: vi.fn(),
      close: vi.fn(() => closing.promise),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    const nextClient = {
      cancel: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(nextClient);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false,
      sessionActive: true
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    firstClient.cancel.mockClear();
    firstClient.close.mockClear();

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(firstClient.cancel).toHaveBeenCalled();
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(firstClient.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      firstClient.close.mock.invocationCallOrder[0]
    );
    expect(result.current.transport).toBe("off");

    act(() => result.current.selectProfile("male-command"));
    await act(async () => Promise.resolve());
    expect(result.current.selectedProfile).toBe("male-command");
    expect(result.current.transport).toBe("off");
    expect(realtimeFactory.create).toHaveBeenCalledOnce();

    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => Promise.resolve());
    expect(result.current.transport).toBe("connecting");
    expect(realtimeFactory.create).toHaveBeenCalledOnce();

    await act(async () => {
      closing.resolve(undefined);
      await closing.promise;
    });

    expect(realtimeFactory.create).toHaveBeenCalledTimes(2);
    expect(nextClient.connect).toHaveBeenCalledWith("male-command");
    expect(result.current.transport).toBe("realtime");
  });

  it("closes on pagehide even when the visibility state has not changed", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const closing = deferred<void>();
    const client = {
      cancel: vi.fn(),
      close: vi.fn(() => closing.promise),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create.mockReturnValue(client);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false,
      sessionActive: true
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    client.cancel.mockClear();
    client.close.mockClear();

    act(() => window.dispatchEvent(new Event("pagehide")));

    expect(client.cancel).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      client.close.mock.invocationCallOrder[0]
    );
    expect(result.current.transport).toBe("off");

    await act(async () => {
      closing.resolve(undefined);
      await closing.promise;
    });
  });

  it("cancels and closes the owned Realtime client during unmount", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const closing = deferred<void>();
    const client = {
      cancel: vi.fn(),
      close: vi.fn(() => closing.promise),
      connect: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockReturnValue(true)
    };
    realtimeFactory.create.mockReturnValue(client);
    const { result, unmount } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false,
      sessionActive: true
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());
    client.cancel.mockClear();
    client.close.mockClear();

    unmount();

    expect(client.cancel).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      client.close.mock.invocationCallOrder[0]
    );

    closing.resolve(undefined);
    await closing.promise;
  });

  it("falls back to a local English voice when Realtime cannot connect", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal("fetch", vi.fn());
    const { synthesis } = speechHarness([
      voice({ name: "Local", lang: "en-GB", localService: true })
    ]);
    const client = {
      cancel: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error("network")),
      speak: vi.fn()
    };
    realtimeFactory.create.mockReturnValue(client);
    const { result } = renderHook(() => useSpokenFramingCoach({
      cue: FRAMING_CUES.finding,
      automatic: false
    }));

    act(() => result.current.toggle());
    await act(async () => Promise.resolve());

    expect(client.close).toHaveBeenCalledOnce();
    expect(result.current.enabled).toBe(true);
    expect(result.current.transport).toBe("device");
    expect(result.current.speechStatus).toMatch(/private on-device English voice/i);
    expect(synthesis.speak).not.toHaveBeenCalled();
  });
});
