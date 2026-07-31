import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoseCoach } from "../usePoseCoach";
import type { AnatomyLayerState, CoachSettings } from "../../types";

const settings: CoachSettings = {
  heightCm: 178,
  bellKg: 16,
  experience: "trained",
  goal: "technique",
  sideView: true
};

const layers: AnatomyLayerState = {
  body: true,
  muscles: false,
  skeleton: true,
  gaussian: false
};

class WorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  postMessage(message: { type: string }) {
    if (message.type === "initialize") {
      queueMicrotask(() => {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { type: "ready", delegate: "GPU", version: "test" }
          })
        );
      });
    }
  }

  terminate() {}
}

function createStream() {
  const track = {
    onended: null,
    stop: vi.fn()
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream;

  return { stream, track };
}

function CameraHarness() {
  const { attachVideo, endSession, mode, startCamera } = usePoseCoach(settings, layers);
  const showCapture = mode === "requesting" || mode === "live";

  return (
    <>
      <output aria-label="Camera mode">{mode}</output>
      <button type="button" onClick={startCamera}>
        Start camera
      </button>
      {showCapture ? (
        <>
          <video ref={attachVideo} aria-label="Camera feed" muted playsInline />
          <button type="button" onClick={endSession}>
            Cancel camera setup
          </button>
        </>
      ) : null}
    </>
  );
}

describe("usePoseCoach camera lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", WorkerStub);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts the video surface before attaching an approved camera stream", async () => {
    const user = userEvent.setup();
    const { stream } = createStream();
    let resolveCamera!: (value: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => {
        resolveCamera = resolve;
      })
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));

    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("requesting");
    const video = screen.getByLabelText("Camera feed") as HTMLVideoElement;

    await act(async () => resolveCamera(stream));

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("live");
    });
    await waitFor(() => expect(video.srcObject).toBe(stream));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("stops a late stream when camera setup is cancelled", async () => {
    const user = userEvent.setup();
    const { stream, track } = createStream();
    let resolveCamera!: (value: MediaStream) => void;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => new Promise<MediaStream>((resolve) => {
          resolveCamera = resolve;
        })
      }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    await user.click(screen.getByRole("button", { name: "Cancel camera setup" }));
    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("ready");

    await act(async () => resolveCamera(stream));
    await waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("ready");
  });
});
