import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({
  startCamera: vi.fn(),
  startDemo: vi.fn(),
  togglePause: vi.fn(),
  endSession: vi.fn(),
  startCalibration: vi.fn(),
  resetCalibration: vi.fn(),
  analyzeClip: vi.fn(),
  cancelClipAnalysis: vi.fn(),
  clipBusy: false
}));

vi.mock("./hooks/usePoseCoach", () => ({
  usePoseCoach: () => ({
    attachVideo: vi.fn(),
    attachOverlay: vi.fn(),
    modelStatus: "ready",
    modelError: "",
    modelDelegate: "GPU",
    mode: "ready",
    source: null,
    cameraError: "",
    analysis: null,
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
  });
  afterEach(cleanup);

  it("presents the camera, preview, privacy, and safety paths", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Set up your camera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start camera" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Preview coaching" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Analyze a clip" })).toBeEnabled();
    expect(screen.getByText(/not stored or uploaded by KB FORM/i)).toBeInTheDocument();
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
});
