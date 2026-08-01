import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipAnalysisOptions, ClipAnalysisRunResult } from "../../hooks/usePoseCoach";
import { VIDEO_CLIP_LIMITS } from "../../lib/videoClip";
import VideoClipWorkspace from "../VideoClipWorkspace";

type AnalyzeClip = (options: ClipAnalysisOptions) => Promise<ClipAnalysisRunResult>;

function createProps(
  analyzeClip: AnalyzeClip = vi.fn<AnalyzeClip>(
    () => new Promise<ClipAnalysisRunResult>(() => undefined)
  )
) {
  return {
    modelStatus: "ready" as const,
    modelError: "",
    analyzeClip,
    cancelClipAnalysis: vi.fn(),
    onClose: vi.fn()
  };
}

function chooseFile(container: HTMLElement, file: File): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Video file input was not rendered.");
  }
  fireEvent.change(input, { target: { files: [file] } });
}

function loadMetadata(video: HTMLVideoElement, duration = 25, width = 1920, height = 1080): void {
  Object.defineProperties(video, {
    duration: { configurable: true, value: duration },
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height }
  });
  fireEvent.loadedMetadata(video);
}

describe("VideoClipWorkspace", () => {
  let createObjectUrl: ReturnType<typeof vi.spyOn>;
  let revokeObjectUrl: ReturnType<typeof vi.spyOn>;
  let nextObjectUrl: number;

  beforeEach(() => {
    nextObjectUrl = 0;
    createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:kb-form-${++nextObjectUrl}`
    );
    revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("presents a private local upload path with explicit formats and limits", () => {
    const { container } = render(<VideoClipWorkspace {...createProps()} />);

    expect(screen.getByRole("heading", { name: "Show us three clear swings" })).toBeInTheDocument();
    const uploadButton = screen.getByRole("button", { name: "Choose a video" });
    expect(uploadButton).toBeEnabled();
    expect(uploadButton).toHaveFocus();
    expect(screen.getByText(/select the clearest 4–10 seconds/i)).toBeInTheDocument();
    expect(screen.getByText(/never leaves this device/i)).toBeInTheDocument();
    expect(screen.getByText(/does not upload, store, or transcode/i)).toBeInTheDocument();
    expect(screen.getByText("MP4 · WebM · MOV")).toBeInTheDocument();
    expect(screen.getByText(
      `Up to ${VIDEO_CLIP_LIMITS.maxSourceSeconds}s · ${Math.round(VIDEO_CLIP_LIMITS.maxBytes / (1024 * 1024))} MB`
    )).toBeInTheDocument();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toHaveAttribute(
      "accept",
      "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
    );
  });

  it.each([
    {
      name: "oversized file",
      makeFile: () => {
        const file = new File(["video"], "swing.mp4", { type: "video/mp4" });
        Object.defineProperty(file, "size", {
          configurable: true,
          value: VIDEO_CLIP_LIMITS.maxBytes + 1
        });
        return file;
      },
      message: /smaller than 200 MB/i
    },
    {
      name: "unsupported file",
      makeFile: () => new File(["not video"], "swing.txt", { type: "text/plain" }),
      message: /choose an MP4, WebM, or MOV video/i
    }
  ])("rejects an $name before creating an object URL", ({ makeFile, message }) => {
    const { container } = render(<VideoClipWorkspace {...createProps()} />);

    chooseFile(container, makeFile());

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Show us three clear swings" })).toBeInTheDocument();
  });

  it("creates a local object URL and enables a ten-second selection after metadata loads", async () => {
    const { container } = render(<VideoClipWorkspace {...createProps()} />);
    const file = new File(["video"], "side-view.mp4", { type: "video/mp4" });

    chooseFile(container, file);

    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledWith(file);
    expect(screen.getByText("Reading clip metadata…")).toBeInTheDocument();

    const video = screen.getByLabelText("Selected source video") as HTMLVideoElement;
    loadMetadata(video, 25, 1920, 1080);

    await waitFor(() => expect(screen.getByText("10.0s selected")).toBeInTheDocument());
    expect(screen.getByRole("slider", { name: /^Start/i })).toHaveValue("0");
    expect(screen.getByRole("slider", { name: /^End/i })).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Analyze selected 10.0s" })).toBeEnabled();
    expect(screen.getByText("1920 × 1080 · 00:25.0")).toBeInTheDocument();
  });

  it("keeps every edited trim window between four and ten seconds", async () => {
    const { container } = render(<VideoClipWorkspace {...createProps()} />);
    chooseFile(container, new File(["video"], "long-swing.webm", { type: "video/webm" }));
    loadMetadata(screen.getByLabelText("Selected source video") as HTMLVideoElement, 30);

    const start = screen.getByRole("slider", { name: /^Start/i });
    const end = screen.getByRole("slider", { name: /^End/i });

    fireEvent.change(end, { target: { value: "30" } });
    await waitFor(() => expect(screen.getByText("10.0s selected")).toBeInTheDocument());
    expect(start).toHaveValue("20");
    expect(end).toHaveValue("30");

    fireEvent.change(start, { target: { value: "29.5" } });
    await waitFor(() => expect(screen.getByText("4.0s selected")).toBeInTheDocument());
    expect(start).toHaveValue("26");
    expect(end).toHaveValue("30");
  });

  it("moves and resizes the analysis crop with distinct keyboard controls", async () => {
    const { container } = render(<VideoClipWorkspace {...createProps()} />);
    chooseFile(container, new File(["video"], "keyboard-crop.mp4", { type: "video/mp4" }));
    loadMetadata(screen.getByLabelText("Selected source video") as HTMLVideoElement, 12);

    const crop = screen.getByRole("group", { name: /^Analysis frame\./i });
    const resize = screen.getByRole("button", { name: /^Resize analysis frame\./i });
    expect(resize).toHaveAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown");

    crop.focus();
    fireEvent.keyDown(crop, { key: "ArrowRight" });
    await waitFor(() => expect(Number.parseFloat(crop.style.left)).toBeCloseTo(15));

    resize.focus();
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(Number.parseFloat(crop.style.width)).toBeCloseTo(71);
      expect(Number.parseFloat(crop.style.left)).toBeCloseTo(15);
    });
    fireEvent.keyDown(resize, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(Number.parseFloat(crop.style.height)).toBeCloseTo(89));
  });

  it("starts analysis with the bounded window, crop, and inference size, then exposes branded progress and cancellation", async () => {
    const user = userEvent.setup();
    const analyzeClip = vi.fn<AnalyzeClip>(
      () => new Promise<ClipAnalysisRunResult>(() => undefined)
    );
    const props = createProps(analyzeClip);
    const { container } = render(<VideoClipWorkspace {...props} />);
    chooseFile(container, new File(["video"], "swing.mov", { type: "video/quicktime" }));
    const video = screen.getByLabelText("Selected source video") as HTMLVideoElement;
    loadMetadata(video, 18, 1920, 1080);

    await user.click(screen.getByRole("button", { name: "Analyze selected 10.0s" }));

    expect(analyzeClip).toHaveBeenCalledOnce();
    expect(analyzeClip).toHaveBeenCalledWith({
      video,
      startTime: 0,
      endTime: 10,
      crop: { x: 0.14, y: 0.04, width: 0.72, height: 0.92 },
      output: { width: 640, height: 460 },
      onProgress: expect.any(Function)
    });
    const progressbar = screen.getByRole("progressbar", { name: "Swing analysis progress" });
    expect(progressbar).toHaveValue(0);
    expect(container.querySelector(".kettlebell-swing-loader__mark")).toBeInTheDocument();
    expect(screen.getByText("Your clip stays on this device")).toBeInTheDocument();

    const options = analyzeClip.mock.calls[0]![0];
    act(() => {
      options.onProgress({
        stage: "checking",
        progress: 0.64,
        processedFrames: 24,
        expectedFrames: 40
      });
    });
    expect(progressbar).toHaveValue(64);
    expect(screen.getByText("Analyzing frame 24 of 40")).toBeInTheDocument();
    expect(screen.getAllByText("Checking visible signals").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Cancel analysis" }));
    expect(props.cancelClipAnalysis).toHaveBeenCalledOnce();
  });

  it("cancels active analysis and returns to the uploader when the decoder errors", async () => {
    const user = userEvent.setup();
    const props = createProps();
    const { container } = render(<VideoClipWorkspace {...props} />);
    chooseFile(container, new File(["video"], "damaged-swing.mp4", { type: "video/mp4" }));
    const video = screen.getByLabelText("Selected source video") as HTMLVideoElement;
    loadMetadata(video, 10);

    await user.click(screen.getByRole("button", { name: "Analyze selected 10.0s" }));
    expect(screen.getByRole("heading", { level: 1, name: "Reading your swing" })).toBeInTheDocument();

    fireEvent.error(video);

    expect(props.cancelClipAnalysis).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:kb-form-1");
    expect(screen.getByRole("heading", { name: "Show us three clear swings" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This browser could not decode the selected video. Try an MP4 or WebM file."
    );
  });

  it("moves focus to the result cue when analysis completes", async () => {
    const user = userEvent.setup();
    const analyzeClip = vi.fn<AnalyzeClip>(async () => ({
      samples: [],
      processedFrames: 60,
      supportedFrames: 0,
      expectedFrames: 60
    }));
    const { container } = render(<VideoClipWorkspace {...createProps(analyzeClip)} />);
    chooseFile(container, new File(["video"], "three-swings.mp4", { type: "video/mp4" }));
    loadMetadata(screen.getByLabelText("Selected source video") as HTMLVideoElement, 10);

    await user.click(screen.getByRole("button", { name: "Analyze selected 10.0s" }));

    const resultHeading = await screen.findByRole("heading", { name: "Unable to assess reliably" });
    expect(resultHeading).toHaveFocus();
  });

  it("revokes each object URL when choosing another clip and on unmount", async () => {
    const user = userEvent.setup();
    const props = createProps();
    const { container, unmount } = render(<VideoClipWorkspace {...props} />);

    chooseFile(container, new File(["one"], "first.mp4", { type: "video/mp4" }));
    expect(createObjectUrl).toHaveReturnedWith("blob:kb-form-1");
    await user.click(screen.getByRole("button", { name: "Choose another video" }));
    expect(props.cancelClipAnalysis).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:kb-form-1");

    chooseFile(container, new File(["two"], "second.webm", { type: "video/webm" }));
    expect(createObjectUrl).toHaveReturnedWith("blob:kb-form-2");
    unmount();

    expect(props.cancelClipAnalysis).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:kb-form-2");
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
  });
});
