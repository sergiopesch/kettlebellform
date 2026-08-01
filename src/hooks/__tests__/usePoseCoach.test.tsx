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

function createStream({
  settings = {},
  capabilities = {},
  constraints = {},
  label = "Test camera"
}: {
  settings?: MediaTrackSettings & { zoom?: number };
  capabilities?: MediaTrackCapabilities & { zoom?: { min: number; max: number } };
  constraints?: MediaTrackConstraints;
  label?: string;
} = {}) {
  const track = {
    onended: null,
    stop: vi.fn(),
    label,
    getSettings: vi.fn(() => settings),
    getCapabilities: vi.fn(() => capabilities),
    getConstraints: vi.fn(() => constraints),
    applyConstraints: vi.fn().mockResolvedValue(undefined)
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream;

  return { stream, track };
}

function CameraHarness() {
  const {
    activeCameraId,
    attachVideo,
    cameraOptics,
    cameraOptions,
    endSession,
    mode,
    selectCamera,
    startCamera,
    toggleCameraMirror
  } = usePoseCoach(settings, layers);
  const showCapture = mode === "requesting" || mode === "live";

  return (
    <>
      <output aria-label="Camera mode">{mode}</output>
      <button type="button" onClick={() => startCamera()}>
        Start camera
      </button>
      <button type="button" onClick={() => startCamera("user")}>
        Start selfie camera
      </button>
      <output aria-label="Camera mirror">{cameraOptics?.mirrored ? "mirrored" : "not mirrored"}</output>
      <output aria-label="Camera zoom">{cameraOptics?.minimumZoomApplied ? "minimum zoom" : "native zoom"}</output>
      {cameraOptics ? (
        <button type="button" onClick={toggleCameraMirror}>Mirror preview</button>
      ) : null}
      {cameraOptions.length > 1 ? (
        <select
          aria-label="Camera choice"
          value={activeCameraId ?? ""}
          onChange={(event) => selectCamera(event.target.value)}
        >
          {!activeCameraId ? <option value="">Current camera</option> : null}
          {cameraOptions.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>
          ))}
        </select>
      ) : null}
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

    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 960 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 4 / 3 },
        frameRate: { ideal: 30, max: 30 },
        resizeMode: { ideal: "none" },
        facingMode: { ideal: "environment" }
      },
      audio: false
    });

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

  it("requests the front camera only when selfie view is selected", async () => {
    const user = userEvent.setup();
    const { stream } = createStream({ settings: { facingMode: "user" } });
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start selfie camera" }));

    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: false,
      video: expect.objectContaining({ facingMode: { ideal: "user" } })
    }));
    await waitFor(() => expect(screen.getByLabelText("Camera mirror")).toHaveTextContent("mirrored"));
  });

  it("enumerates cameras only after permission and stops the old track before switching", async () => {
    const user = userEvent.setup();
    const first = createStream({ settings: { deviceId: "room", facingMode: "environment" } });
    const second = createStream({ settings: { deviceId: "wide", facingMode: "environment" } });
    let resolvePermission!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => {
        resolvePermission = resolve;
      }))
      .mockResolvedValueOnce(second.stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "videoinput", deviceId: "room", label: "Room camera" },
      { kind: "videoinput", deviceId: "wide", label: "Wide camera" }
    ] as MediaDeviceInfo[]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    expect(enumerateDevices).not.toHaveBeenCalled();
    await act(async () => resolvePermission(first.stream));

    const picker = await screen.findByRole("combobox", { name: "Camera choice" });
    expect(enumerateDevices).toHaveBeenCalledOnce();
    await user.selectOptions(picker, "wide");

    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenNthCalledWith(2, expect.objectContaining({
      audio: false,
      video: expect.objectContaining({ deviceId: { exact: "wide" } })
    }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("live"));
  });

  it("falls back to the preferred room camera when an explicitly selected device disappears", async () => {
    const user = userEvent.setup();
    const first = createStream({ settings: { deviceId: "room", facingMode: "environment" } });
    const fallback = createStream({ settings: { deviceId: "fallback", facingMode: "environment" } });
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first.stream)
      .mockRejectedValueOnce(new DOMException("Gone", "NotFoundError"))
      .mockResolvedValueOnce(fallback.stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "videoinput", deviceId: "room", label: "Room camera" },
      { kind: "videoinput", deviceId: "gone", label: "Detached camera" }
    ] as MediaDeviceInfo[]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    const picker = await screen.findByRole("combobox", { name: "Camera choice" });
    await user.selectOptions(picker, "gone");

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    expect(getUserMedia).toHaveBeenNthCalledWith(3, expect.objectContaining({
      video: expect.objectContaining({ facingMode: { ideal: "environment" } })
    }));
    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("live");
  });

  it("does not launch a stale fallback camera request after setup is cancelled", async () => {
    const user = userEvent.setup();
    const first = createStream({ settings: { deviceId: "room", facingMode: "environment" } });
    const fallback = createStream({ settings: { deviceId: "fallback", facingMode: "environment" } });
    let rejectExactRequest!: (reason: unknown) => void;
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first.stream)
      .mockImplementationOnce(() => new Promise<MediaStream>((_resolve, reject) => {
        rejectExactRequest = reject;
      }))
      .mockResolvedValueOnce(fallback.stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "videoinput", deviceId: "room", label: "Room camera" },
      { kind: "videoinput", deviceId: "gone", label: "Detached camera" }
    ] as MediaDeviceInfo[]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    const picker = await screen.findByRole("combobox", { name: "Camera choice" });
    await user.selectOptions(picker, "gone");
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Cancel camera setup" }));
    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("ready");
    await act(async () => rejectExactRequest(new DOMException("Gone", "NotFoundError")));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("ready");
  });

  it("does not retry denied camera permission", async () => {
    const user = userEvent.setup();
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn() }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("ready"));
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("best-effort resets an already exposed optical zoom without blocking the stream", async () => {
    const user = userEvent.setup();
    const trackSettings = { facingMode: "environment", zoom: 2 };
    const { stream, track } = createStream({
      settings: trackSettings,
      capabilities: { zoom: { min: 1, max: 4 } }
    });
    vi.mocked(track.applyConstraints).mockImplementation(async () => {
      trackSettings.zoom = 1;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));

    await waitFor(() => expect(track.applyConstraints).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Camera zoom")).toHaveTextContent("minimum zoom");
    expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("live");
  });

  it("keeps the camera usable when minimum zoom is rejected", async () => {
    const user = userEvent.setup();
    const { stream, track } = createStream({
      settings: { facingMode: "environment", zoom: 2 },
      capabilities: { zoom: { min: 1, max: 4 } }
    });
    vi.mocked(track.applyConstraints).mockRejectedValue(new DOMException("PTZ blocked", "SecurityError"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("live"));
    expect(screen.getByLabelText("Camera zoom")).toHaveTextContent("native zoom");
  });

  it("keeps the stream usable when optional optics capability inspection throws", async () => {
    const user = userEvent.setup();
    const { stream, track } = createStream({ settings: { facingMode: "environment" } });
    vi.mocked(track.getCapabilities).mockImplementation(() => {
      throw new DOMException("Capabilities unavailable", "NotSupportedError");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "Camera mode" })).toHaveTextContent("live"));
    expect(screen.getByLabelText("Camera zoom")).toHaveTextContent("native zoom");
  });

  it("lets the user correct preview mirroring when a camera omits facing metadata", async () => {
    const user = userEvent.setup();
    const { stream } = createStream({ settings: {} });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });

    render(<CameraHarness />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(screen.getByLabelText("Camera mirror")).toHaveTextContent("not mirrored"));

    await user.click(screen.getByRole("button", { name: "Mirror preview" }));
    expect(screen.getByLabelText("Camera mirror")).toHaveTextContent("mirrored");
  });
});
