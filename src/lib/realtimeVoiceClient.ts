import {
  isCoachVoiceMessage,
  isVoiceProfileId,
  type CoachVoiceMessage,
  type VoiceProfileId
} from "./coachVoiceProfiles";

export const REALTIME_VOICE_CONNECT_TIMEOUT_MS = 12_000;
export const REALTIME_VOICE_CLOSE_GRACE_MS = 750;
export const REALTIME_VOICE_SESSION_ENDPOINT = "/api/realtime-session";
export const REALTIME_VOICE_CUE_ENDPOINT = "/api/realtime-cue";
export const REALTIME_VOICE_SESSION_HEADER = "X-KB-Realtime-Session";

const CONNECTION_ERROR = "AI voice could not connect. Visual coaching remains available.";
const PLAYBACK_ERROR = "AI voice playback was blocked. Visual coaching remains available.";
const RESPONSE_ERROR = "AI voice could not speak. Visual coaching remains available.";
const CUE_ERROR = "That voice cue is not available.";
const PROFILE_ERROR = "Start a new AI voice session to change coach voices.";
const CLOSED_ERROR = "AI voice session is closed.";

export type RealtimeVoiceClientState =
  | "idle"
  | "connecting"
  | "ready"
  | "speaking"
  | "error"
  | "closed";

export type RealtimeVoiceStatus = Readonly<{
  state: RealtimeVoiceClientState;
  profile: VoiceProfileId | null;
  message: string;
}>;

export type RealtimeVoiceClientOptions = {
  onStatusChange?: (status: RealtimeVoiceStatus) => void;
  onError?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  createPeerConnection?: () => RTCPeerConnection;
  createAudioElement?: () => HTMLAudioElement;
};

function validAnswerSdp(value: string): boolean {
  return value.trimStart().startsWith("v=");
}

function defaultPeerConnection(): RTCPeerConnection {
  if (typeof RTCPeerConnection !== "function") {
    throw new Error(CONNECTION_ERROR);
  }
  return new RTCPeerConnection();
}

function defaultAudioElement(): HTMLAudioElement {
  if (typeof document === "undefined") {
    throw new Error(CONNECTION_ERROR);
  }
  return document.createElement("audio");
}

export class RealtimeVoiceClient {
  private readonly onStatusChange?: (status: RealtimeVoiceStatus) => void;
  private readonly onError?: (message: string) => void;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createPeerConnection: () => RTCPeerConnection;
  private readonly createAudioElement: () => HTMLAudioElement;

  private state: RealtimeVoiceClientState = "idle";
  private statusMessage = "";
  private profile: VoiceProfileId | null = null;
  private peer: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;
  private abortController: AbortController | null = null;
  private cueAbortController: AbortController | null = null;
  private cancelAbortController: AbortController | null = null;
  private cancelPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private timeoutHandle: number | null = null;
  private connectPromise: Promise<void> | null = null;
  private interruptConnection: (() => void) | null = null;
  private sessionToken: string | null = null;
  private sessionEpoch = 0;
  private closed = false;
  private nextCueGeneration = 0;
  private audioResumeGeneration: number | null = null;
  private activeCueGeneration: number | null = null;
  private activeCueId: CoachVoiceMessage["id"] | null = null;

  constructor(options: RealtimeVoiceClientOptions = {}) {
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.createPeerConnection = options.createPeerConnection ?? defaultPeerConnection;
    this.createAudioElement = options.createAudioElement ?? defaultAudioElement;
  }

  get status(): RealtimeVoiceStatus {
    return Object.freeze({
      state: this.state,
      profile: this.profile,
      message: this.statusMessage
    });
  }

  connect(profile: VoiceProfileId): Promise<void> {
    if (!isVoiceProfileId(profile)) {
      return this.rejectedOperation(PROFILE_ERROR);
    }
    if (this.closed) {
      return this.rejectedOperation(CLOSED_ERROR);
    }
    if (this.profile && this.profile !== profile) {
      return this.rejectedOperation(PROFILE_ERROR);
    }
    if (this.state === "ready" || this.state === "speaking") {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.profile = profile;
    this.emitStatus("connecting");
    const epoch = ++this.sessionEpoch;
    const promise = this.startConnection(profile, epoch).finally(() => {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = promise;
    return promise;
  }

  speak(message: CoachVoiceMessage): boolean {
    if (!isCoachVoiceMessage(message)) {
      this.reportOperationError(CUE_ERROR);
      return false;
    }
    if (
      this.closed ||
      (this.state !== "ready" && this.state !== "speaking") ||
      !this.sessionToken
    ) {
      return false;
    }
    if (this.activeCueId === message.id && this.activeCueGeneration !== null) {
      return false;
    }

    if (this.activeCueGeneration !== null) {
      const replacementEpoch = this.sessionEpoch;
      this.cancel();
      if (
        this.closed ||
        this.sessionEpoch !== replacementEpoch ||
        !this.sessionToken
      ) {
        return false;
      }
    }

    const generation = ++this.nextCueGeneration;
    const epoch = this.sessionEpoch;
    const token = this.sessionToken;
    this.abortBestEffort(this.cueAbortController);
    const controller = new AbortController();
    this.cueAbortController = controller;
    this.activeCueGeneration = generation;
    this.activeCueId = message.id;
    this.emitStatus("speaking");

    void this.sendSpeakRequest({
      controller,
      cueId: message.id,
      epoch,
      generation,
      token
    });
    return true;
  }

  cancel(): void {
    if (
      this.closed ||
      !this.sessionToken ||
      this.state === "error" ||
      this.activeCueGeneration === null
    ) {
      return;
    }
    const epoch = this.sessionEpoch;
    const token = this.sessionToken;
    this.abortBestEffort(this.cueAbortController);
    this.cueAbortController = null;
    this.pauseOwnedAudio();
    this.clearActiveCue();

    if (!this.cancelPromise) {
      const cancelController = new AbortController();
      this.cancelAbortController = cancelController;
      const cancelPromise = this.postCueRequest(
        { action: "cancel" },
        token,
        cancelController.signal
      ).then(() => undefined);
      this.cancelPromise = cancelPromise;
      void cancelPromise
        .catch(() => {
          if (epoch === this.sessionEpoch && !this.closed) {
            this.failSession(RESPONSE_ERROR, epoch);
          }
        })
        .finally(() => {
          if (this.cancelPromise === cancelPromise) {
            this.cancelPromise = null;
            this.cancelAbortController = null;
          }
        });
    }

    if (!this.closed && epoch === this.sessionEpoch) {
      this.emitStatus("ready");
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.closed) {
      return Promise.resolve();
    }

    this.closed = true;
    const token = this.sessionToken;
    const hadActiveCue = this.activeCueGeneration !== null;

    this.interruptPendingConnection();
    this.abortBestEffort(this.abortController);
    this.abortController = null;
    this.abortBestEffort(this.cueAbortController);
    this.cueAbortController = null;
    this.pauseOwnedAudio();
    this.clearActiveCue();
    this.emitStatus("closed");

    let cancellation = this.cancelPromise;
    let cancellationController = this.cancelAbortController;
    if (!cancellation && token && hadActiveCue) {
      cancellationController = new AbortController();
      this.cancelAbortController = cancellationController;
      cancellation = this.postCueRequest(
        { action: "cancel" },
        token,
        cancellationController.signal
      ).then(() => undefined);
      this.cancelPromise = cancellation;
    }

    if (!cancellation) {
      this.destroyResources();
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }

    const closePromise = this.finishCloseAfterCancellation(
      cancellation,
      cancellationController
    );
    this.closePromise = closePromise;
    return closePromise;
  }

  private async finishCloseAfterCancellation(
    cancellation: Promise<void>,
    controller: AbortController | null
  ): Promise<void> {
    let timeoutHandle: number | null = null;
    const boundedWait = new Promise<void>((resolve) => {
      timeoutHandle = globalThis.setTimeout(resolve, REALTIME_VOICE_CLOSE_GRACE_MS);
    });
    try {
      await Promise.race([cancellation.catch(() => undefined), boundedWait]);
    } finally {
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
      }
      try {
        this.abortBestEffort(controller);
      } finally {
        this.destroyResources();
      }
    }
  }

  private async startConnection(profile: VoiceProfileId, epoch: number): Promise<void> {
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => reject(new Error(CONNECTION_ERROR));
    });
    this.interruptConnection = interrupt;
    const timeout = new Promise<never>((_, reject) => {
      this.timeoutHandle = globalThis.setTimeout(() => {
        this.abortBestEffort(this.abortController);
        reject(new Error(CONNECTION_ERROR));
      }, REALTIME_VOICE_CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.negotiate(profile, epoch), timeout, interrupted]);
      if (this.closed || epoch !== this.sessionEpoch) {
        throw new Error(CONNECTION_ERROR);
      }
      this.emitStatus("ready");
    } catch {
      if (!this.closed && epoch === this.sessionEpoch) {
        this.failSession(CONNECTION_ERROR, epoch);
      }
      throw new Error(CONNECTION_ERROR);
    } finally {
      if (this.interruptConnection === interrupt) {
        this.interruptConnection = null;
      }
      if (this.timeoutHandle !== null) {
        globalThis.clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
    }
  }

  private async negotiate(profile: VoiceProfileId, epoch: number): Promise<void> {
    const peer = this.createPeerConnection();
    const audio = this.createAudioElement();
    audio.autoplay = true;
    this.peer = peer;
    this.audio = audio;

    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.addEventListener("track", (event) => {
      if (epoch === this.sessionEpoch && !this.closed) {
        this.handleRemoteTrack(event as RTCTrackEvent, epoch);
      }
    });
    peer.addEventListener("connectionstatechange", () => {
      if (
        epoch === this.sessionEpoch &&
        !this.closed &&
        (peer.connectionState === "failed" || peer.connectionState === "closed")
      ) {
        this.failSession(CONNECTION_ERROR, epoch);
      }
    });

    const offer = await peer.createOffer();
    if (epoch !== this.sessionEpoch || this.closed || !offer.sdp || !validAnswerSdp(offer.sdp)) {
      throw new Error(CONNECTION_ERROR);
    }
    await peer.setLocalDescription(offer);
    if (epoch !== this.sessionEpoch || this.closed) {
      throw new Error(CONNECTION_ERROR);
    }

    const controller = new AbortController();
    this.abortController = controller;
    const response = await this.fetchImpl(
      `${REALTIME_VOICE_SESSION_ENDPOINT}?profile=${encodeURIComponent(profile)}`,
      {
        body: offer.sdp,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp"
        },
        method: "POST",
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(CONNECTION_ERROR);
    }
    const sessionToken = response.headers.get(REALTIME_VOICE_SESSION_HEADER);
    if (!sessionToken || sessionToken.length > 1_024 || !sessionToken.startsWith("kb1.")) {
      throw new Error(CONNECTION_ERROR);
    }
    const answerSdp = await response.text();
    if (epoch !== this.sessionEpoch || this.closed || !validAnswerSdp(answerSdp)) {
      throw new Error(CONNECTION_ERROR);
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    if (epoch !== this.sessionEpoch || this.closed) {
      throw new Error(CONNECTION_ERROR);
    }
    this.sessionToken = sessionToken;
  }

  private handleRemoteTrack(event: RTCTrackEvent, epoch: number): void {
    const stream = event.streams[0] ??
      (typeof MediaStream === "function" ? new MediaStream([event.track]) : null);
    if (!stream || !this.audio) {
      this.failSession(PLAYBACK_ERROR, epoch);
      return;
    }

    if (this.remoteStream && this.remoteStream !== stream) {
      for (const track of this.remoteStream.getTracks()) {
        track.stop();
      }
    }
    this.remoteStream = stream;
    this.audio.srcObject = stream;
    try {
      const playback = this.audio.play();
      void playback.catch(() => {
        if (epoch === this.sessionEpoch && !this.closed) {
          this.failSession(PLAYBACK_ERROR, epoch);
        }
      });
    } catch {
      this.failSession(PLAYBACK_ERROR, epoch);
    }
  }

  private async sendSpeakRequest({
    controller,
    cueId,
    epoch,
    generation,
    token
  }: {
    controller: AbortController;
    cueId: CoachVoiceMessage["id"];
    epoch: number;
    generation: number;
    token: string;
  }): Promise<void> {
    try {
      const pendingCancel = this.cancelPromise;
      if (pendingCancel) {
        await pendingCancel;
      }
      if (!this.isCurrentCue(controller, epoch, generation)) {
        return;
      }
      const audio = this.audio;
      if (audio?.paused) {
        this.audioResumeGeneration = generation;
        try {
          await audio.play();
        } catch (error) {
          if (this.audioResumeGeneration === generation) {
            this.audioResumeGeneration = null;
          }
          throw error;
        }
        if (!this.isCurrentCue(controller, epoch, generation)) {
          if (this.audioResumeGeneration === generation) {
            audio.pause();
            this.audioResumeGeneration = null;
          }
          return;
        }
        if (this.audioResumeGeneration === generation) {
          this.audioResumeGeneration = null;
        }
      }
      await this.postCueRequest(
        { action: "speak", cueId },
        token,
        controller.signal
      );
      if (!this.isCurrentCue(controller, epoch, generation)) {
        return;
      }
      this.cueAbortController = null;
      this.clearActiveCue();
      this.emitStatus("ready");
    } catch {
      if (!controller.signal.aborted && epoch === this.sessionEpoch && !this.closed) {
        this.failSession(RESPONSE_ERROR, epoch);
      }
    }
  }

  private isCurrentCue(
    controller: AbortController,
    epoch: number,
    generation: number
  ): boolean {
    return (
      !controller.signal.aborted &&
      !this.closed &&
      epoch === this.sessionEpoch &&
      generation === this.activeCueGeneration
    );
  }

  private async postCueRequest(
    action: { action: "cancel" } | { action: "speak"; cueId: CoachVoiceMessage["id"] },
    token: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const response = await this.fetchImpl(REALTIME_VOICE_CUE_ENDPOINT, {
      body: JSON.stringify(action),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [REALTIME_VOICE_SESSION_HEADER]: token
      },
      keepalive: action.action === "cancel",
      method: "POST",
      signal
    });
    if (!response.ok || response.status !== 204) {
      throw new Error(RESPONSE_ERROR);
    }
    return response;
  }

  private clearActiveCue(): void {
    this.activeCueGeneration = null;
    this.activeCueId = null;
  }

  private failSession(message: string, epoch: number): void {
    if (this.closed || epoch !== this.sessionEpoch || this.state === "error") {
      return;
    }
    this.destroyResources();
    this.emitStatus("error", message);
    this.onError?.(message);
  }

  private destroyResources(): void {
    ++this.sessionEpoch;
    this.interruptPendingConnection();
    if (this.timeoutHandle !== null) {
      globalThis.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.abortBestEffort(this.abortController);
    this.abortController = null;
    this.abortBestEffort(this.cueAbortController);
    this.cueAbortController = null;
    this.abortBestEffort(this.cancelAbortController);
    this.cancelAbortController = null;
    this.cancelPromise = null;
    this.sessionToken = null;
    this.clearActiveCue();

    const peer = this.peer;
    this.peer = null;
    try {
      peer?.close();
    } catch {
      // Closing an already-failed peer is best effort.
    }

    const remoteStream = this.remoteStream;
    this.remoteStream = null;
    if (remoteStream) {
      try {
        for (const track of remoteStream.getTracks()) {
          try {
            track.stop();
          } catch {
            // One faulty track must not strand the remaining resources.
          }
        }
      } catch {
        // A faulty stream must not prevent audio-element cleanup.
      }
    }
    const audio = this.audio;
    if (audio) {
      this.pauseOwnedAudio();
      this.audio = null;
      try {
        audio.srcObject = null;
      } catch {
        // Detaching a failed media element is best effort.
      }
      try {
        audio.remove();
      } catch {
        // Removing a failed media element is best effort.
      }
    }
  }

  private pauseOwnedAudio(): void {
    try {
      if (this.audio && !this.audio.paused) {
        this.audio.pause();
      }
    } catch {
      // Peer closure remains the final fallback for a faulty media element.
    }
  }

  private interruptPendingConnection(): void {
    const interrupt = this.interruptConnection;
    this.interruptConnection = null;
    interrupt?.();
  }

  private abortBestEffort(controller: AbortController | null): void {
    try {
      controller?.abort();
    } catch {
      // A failed request abort must not strand another owned resource.
    }
  }

  private emitStatus(state: RealtimeVoiceClientState, message = ""): void {
    this.state = state;
    this.statusMessage = message;
    try {
      this.onStatusChange?.(Object.freeze({
        state,
        profile: this.profile,
        message
      }));
    } catch {
      // Consumer observers must not interfere with transport cleanup.
    }
  }

  private reportOperationError(message: string): void {
    this.onError?.(message);
  }

  private rejectedOperation(message: string): Promise<never> {
    this.reportOperationError(message);
    return Promise.reject(new Error(message));
  }
}

export function createRealtimeVoiceClient(
  options: RealtimeVoiceClientOptions = {}
): RealtimeVoiceClient {
  return new RealtimeVoiceClient(options);
}
