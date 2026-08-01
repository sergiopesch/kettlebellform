import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({
  startCamera: vi.fn(),
  selectCamera: vi.fn(),
  refreshCameraOptions: vi.fn(),
  toggleCameraMirror: vi.fn(),
  startDemo: vi.fn(),
  togglePause: vi.fn(),
  endSession: vi.fn(),
  startCalibration: vi.fn(),
  resetCalibration: vi.fn(),
  analyzeClip: vi.fn(),
  cancelClipAnalysis: vi.fn(),
  clipBusy: false,
  mode: "ready",
  source: null as "camera" | "demo" | null,
  analysis: null,
  cameraOptions: [] as Array<{ deviceId: string; label: string }>,
  activeCameraId: null as string | null,
  cameraOptics: null as null | {
    mirrored: boolean;
    mirroringKnown: boolean;
    width: number | null;
    height: number | null;
    aspectRatio: number | null;
    minimumZoomApplied: boolean;
  }
}));

vi.mock("./hooks/usePoseCoach", () => ({
  usePoseCoach: () => ({
    attachVideo: vi.fn(),
    attachOverlay: vi.fn(),
    modelStatus: "ready",
    modelError: "",
    modelDelegate: "GPU",
    cameraError: "",
    inferenceMs: null,
    calibration: null,
    isCalibrating: false,
    calibrationProgress: 0,
    calibrationMessage: "",
    ...controller
  })
}));

import App from "./App";

describe("KB FORM setup experience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controller.clipBusy = false;
    controller.mode = "ready";
    controller.source = null;
    controller.analysis = null;
    controller.cameraOptions = [];
    controller.activeCameraId = null;
    controller.cameraOptics = null;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "speechSynthesis");
  });

  it("presents the camera, preview, privacy, and safety paths", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Set up your camera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start camera" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Preview coaching" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Analyze a clip" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Room view/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Selfie view/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Fill about 55–80% of the full frame/i)).toBeInTheDocument();
    expect(screen.queryByText(/2–3 m/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voice framing coach/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /British male command coach/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: /British female command coach/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText(/browser sends only an allowlisted cue ID/i)).toBeInTheDocument();
    expect(screen.getByText(/AI-generated speech, not a human coach recording/i)).toBeInTheDocument();
    expect(screen.getByText(/Technique awareness, not a safety verdict/i)).toBeInTheDocument();
  });

  it("moves focus into the local clip workspace and restores it after closing", async () => {
    const user = userEvent.setup();
    render(<App />);

    const trigger = screen.getByRole("button", { name: "Analyze a clip" });
    await user.click(trigger);

    expect(await screen.findByRole("heading", { name: "Show us three clear swings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a video" })).toHaveFocus();
    expect(screen.getByText(/never leaves this device/i)).toBeInTheDocument();
    expect(controller.startCamera).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close clip analysis" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze a clip" })).toHaveFocus());
  });

  it("disables settings while a clip analysis is running", () => {
    controller.clipBusy = true;
    render(<App />);

    expect(screen.getByRole("button", { name: "Open settings" })).toBeDisabled();
  });

  it("opens keyboard-addressable settings and exposes non-medical focus choices", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = screen.getByRole("dialog", { name: "Coaching setup" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Technique" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Conditioning" })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).queryByRole("button", { name: /rehab/i })).not.toBeInTheDocument();
  });

  it("routes preview coaching without requesting camera access", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Preview coaching" }));
    expect(controller.startDemo).toHaveBeenCalledOnce();
    expect(controller.startCamera).not.toHaveBeenCalled();
  });

  it("starts the recommended room view and lets the user choose selfie view", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Start camera" }));
    expect(controller.startCamera).toHaveBeenLastCalledWith("environment");

    await user.click(screen.getByRole("button", { name: /Selfie view/i }));
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    expect(controller.startCamera).toHaveBeenLastCalledWith("user");
  });

  it("uses an on-device English fallback only after explicit opt-in", async () => {
    const user = userEvent.setup();
    const speak = vi.fn();
    class Utterance {
      voice: SpeechSynthesisVoice | null = null;
      lang = "";
      rate = 1;
      pitch = 1;
      volume = 1;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    const localVoice = {
      default: true,
      lang: "en-GB",
      localService: true,
      name: "System voice",
      voiceURI: "system"
    } as SpeechSynthesisVoice;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        cancel: vi.fn(),
        speak,
        getVoices: () => [localVoice],
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    });
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);

    render(<App />);
    const toggle = screen.getByRole("button", { name: /Voice framing coach/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(speak).toHaveBeenCalledOnce();
    expect((speak.mock.calls[0][0] as Utterance).text).toBe("Voice framing coach on.");
    expect((speak.mock.calls[0][0] as Utterance).voice).toBe(localVoice);
    expect(screen.queryByText(/no microphone or audio recording/i)).not.toBeInTheDocument();
    expect(screen.getByText(/private device fallback/i)).toBeInTheDocument();
  });

  it("lets the user choose either AI command profile before enabling speech", async () => {
    const user = userEvent.setup();
    render(<App />);

    const male = screen.getByRole("button", { name: /British male command coach/i });
    const female = screen.getByRole("button", { name: /British female command coach/i });
    expect(female).toHaveAttribute("aria-pressed", "true");

    await user.click(male);

    expect(male).toHaveAttribute("aria-pressed", "true");
    expect(female).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Voice framing coach/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("renders a faithful full-frame live preview and an exact camera picker", async () => {
    const user = userEvent.setup();
    controller.mode = "live";
    controller.source = "camera";
    controller.cameraOptics = {
      mirrored: true,
      mirroringKnown: true,
      width: 720,
      height: 960,
      aspectRatio: 0.75,
      minimumZoomApplied: false
    };
    controller.activeCameraId = "front";
    controller.cameraOptions = [
      { deviceId: "front", label: "Front camera" },
      { deviceId: "wide", label: "Rear camera" }
    ];

    render(<App />);

    const video = screen.getByLabelText("Mirrored live camera feed");
    expect(video).toHaveClass("is-mirrored");
    const capture = video.closest(".capture-media");
    expect(capture).toHaveStyle({ aspectRatio: "0.75" });
    expect(screen.getByText("Step into view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mirror camera preview" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Mirror camera preview" }));
    expect(controller.toggleCameraMirror).toHaveBeenCalledOnce();
    await user.selectOptions(screen.getByRole("combobox", { name: "Camera" }), "wide");
    expect(controller.selectCamera).toHaveBeenCalledWith("wide");
  });
});
