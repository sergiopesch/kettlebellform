import { chromium } from "@playwright/test";
import { installVercelProtectionBypass } from "./protection-bypass.mjs";

const baseUrl = process.env.KB_FORM_BASE_URL || "http://127.0.0.1:5173";
const protectionBypass = process.env.KB_FORM_PROTECTION_BYPASS;
let stage = "launch";
let diagnosticsPage = null;
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"]
});

try {
  const context = await browser.newContext({
    baseURL: baseUrl,
    permissions: []
  });
  if (protectionBypass) {
    await installVercelProtectionBypass(context, baseUrl, protectionBypass);
  }
  const page = await context.newPage();
  diagnosticsPage = page;
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push("console-error");
    }
  });
  page.on("pageerror", () => consoleErrors.push("page-error"));

  await page.addInitScript(() => {
    const smoke = {
      audioPlayCalls: 0,
      dataChannelCreations: 0,
      fetches: [],
      getUserMediaCalls: [],
      peers: [],
      receivedAudioSessions: 0,
      transceivers: []
    };
    Object.defineProperty(window, "__kbRealtimeSmoke", {
      configurable: false,
      value: smoke
    });

    const NativePeerConnection = window.RTCPeerConnection;
    const WrappedPeerConnection = function (...args) {
      const peer = new NativePeerConnection(...args);
      smoke.peers.push(peer);
      return peer;
    };
    WrappedPeerConnection.prototype = NativePeerConnection.prototype;
    Object.setPrototypeOf(WrappedPeerConnection, NativePeerConnection);
    window.RTCPeerConnection = WrappedPeerConnection;

    const nativeAddTransceiver = NativePeerConnection.prototype.addTransceiver;
    NativePeerConnection.prototype.addTransceiver = function (trackOrKind, options) {
      smoke.transceivers.push({
        direction: options?.direction ?? null,
        kind: typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind
      });
      return nativeAddTransceiver.call(this, trackOrKind, options);
    };

    const nativeCreateDataChannel = NativePeerConnection.prototype.createDataChannel;
    NativePeerConnection.prototype.createDataChannel = function (...args) {
      smoke.dataChannelCreations += 1;
      return nativeCreateDataChannel.apply(this, args);
    };

    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      smoke.audioPlayCalls += 1;
      return nativePlay.call(this);
    };

    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.getUserMedia) {
      const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      mediaDevices.getUserMedia = (constraints) => {
        smoke.getUserMediaCalls.push({
          audio: Boolean(constraints?.audio),
          video: Boolean(constraints?.video)
        });
        return nativeGetUserMedia(constraints);
      };
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const record = {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        path: url.pathname,
        status: 0
      };
      smoke.fetches.push(record);
      const response = await nativeFetch(input, init);
      record.status = response.status;
      return response;
    };
  });

  stage = "load";
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Start camera" }).waitFor({ state: "visible" });

  const voiceToggle = page.locator(".voice-coach-toggle");
  stage = "female-connect";
  await voiceToggle.click();
  await page.waitForFunction(() =>
    document.querySelector(".voice-coach-toggle")?.textContent?.includes("OpenAI Realtime")
  );
  await page.waitForFunction(() =>
    window.__kbRealtimeSmoke.fetches.some(
      (entry) => entry.path === "/api/realtime-cue" && entry.status === 204
    ), null, {
    timeout: 15_000
  });

  stage = "female-audio";
  await page.waitForFunction(async () => {
    const peer = window.__kbRealtimeSmoke.peers.at(-1);
    if (!peer) return false;
    const stats = await peer.getStats();
    let bytes = 0;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") {
        bytes += Number(report.bytesReceived ?? 0);
      }
    });
    return bytes > 0;
  }, null, { timeout: 15_000 });
  await page.evaluate(() => {
    window.__kbRealtimeSmoke.receivedAudioSessions = 1;
  });

  stage = "male-switch";
  await page.getByRole("button", {
    name: "British male command coach, AI-generated"
  }).click();
  await page.waitForFunction(() =>
    window.__kbRealtimeSmoke.peers.length >= 2 &&
      document.querySelector(".voice-coach-toggle")?.textContent?.includes("British male")
  );
  await page.waitForFunction(() =>
    window.__kbRealtimeSmoke.fetches.filter(
      (entry) => entry.path === "/api/realtime-cue" && entry.status === 204
    ).length >= 2, null, {
    timeout: 15_000
  });

  stage = "male-audio";
  await page.waitForFunction(async () => {
    const peer = window.__kbRealtimeSmoke.peers.at(-1);
    if (!peer) return false;
    const stats = await peer.getStats();
    let bytes = 0;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") {
        bytes += Number(report.bytesReceived ?? 0);
      }
    });
    return bytes > 0;
  }, null, { timeout: 15_000 });
  await page.evaluate(() => {
    window.__kbRealtimeSmoke.receivedAudioSessions = 2;
  });

  stage = "replacement-sideband";
  const replacement = await page.evaluate(async () => {
    const smoke = window.__kbRealtimeSmoke;
    const peer = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.addEventListener("track", (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play();
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const sessionResponse = await fetch("/api/realtime-session?profile=female-command", {
      body: offer.sdp,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/sdp",
        "Content-Type": "application/sdp"
      },
      method: "POST"
    });
    const sessionToken = sessionResponse.headers.get("X-KB-Realtime-Session");
    if (!sessionResponse.ok || !sessionToken) {
      throw new Error("replacement session failed");
    }
    await peer.setRemoteDescription({
      type: "answer",
      sdp: await sessionResponse.text()
    });

    const postCue = (cueId) => fetch("/api/realtime-cue", {
      body: JSON.stringify({ action: "speak", cueId }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-KB-Realtime-Session": sessionToken
      },
      method: "POST"
    });

    const firstCue = postCue("step-back");
    const startedAt = performance.now();
    let bytesBeforeReplacement = 0;
    while (performance.now() - startedAt < 8_000) {
      const stats = await peer.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          bytesBeforeReplacement += Number(report.bytesReceived ?? 0);
        }
      });
      if (bytesBeforeReplacement > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (bytesBeforeReplacement === 0) {
      throw new Error("replacement audio did not start");
    }

    const secondCue = postCue("move-left");
    const [firstResponse, secondResponse] = await Promise.all([firstCue, secondCue]);
    smoke.receivedAudioSessions = 3;
    peer.close();
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    return {
      audioStarted: bytesBeforeReplacement > 0,
      statuses: [firstResponse.status, secondResponse.status]
    };
  });

  stage = "pre-teardown";
  const toggleWasEnabledBeforeTeardown =
    await voiceToggle.getAttribute("aria-pressed") === "true";
  if (!toggleWasEnabledBeforeTeardown) {
    throw new Error("voice coach disabled before teardown");
  }

  stage = "teardown";
  await voiceToggle.click();
  await page.waitForFunction(() =>
    document.querySelector(".voice-coach-toggle")?.getAttribute("aria-pressed") === "false"
  );

  const result = await page.evaluate(async ({ replacementResult, wasEnabledBeforeTeardown }) => {
    const smoke = window.__kbRealtimeSmoke;
    const audioBytes = [];
    for (const peer of smoke.peers) {
      let bytes = 0;
      try {
        const stats = await peer.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            bytes += Number(report.bytesReceived ?? 0);
          }
        });
      } catch {
        // A closed peer may no longer expose stats; prior waits already proved receipt.
      }
      audioBytes.push(bytes);
    }
    return {
      audioPlayInvoked: smoke.audioPlayCalls >= 3,
      browserDataChannels: smoke.dataChannelCreations,
      endpointCalls: smoke.fetches.filter((entry) =>
        entry.path === "/api/realtime-session" || entry.path === "/api/realtime-cue"
      )
        .map((entry) => ({ method: entry.method, status: entry.status })),
      microphoneRequests: smoke.getUserMediaCalls.filter((entry) => entry.audio).length,
      peerCount: smoke.peers.length,
      peersClosed: smoke.peers.every((peer) => peer.connectionState === "closed"),
      receivedAudioBeforeTeardown: smoke.receivedAudioSessions >= 3,
      replacement: replacementResult,
      toggleWasEnabledBeforeTeardown: wasEnabledBeforeTeardown,
      transceivers: smoke.transceivers
    };
  }, {
    replacementResult: replacement,
    wasEnabledBeforeTeardown: toggleWasEnabledBeforeTeardown
  });

  const passed =
    result.audioPlayInvoked &&
    result.browserDataChannels === 0 &&
    result.endpointCalls.length === 7 &&
    result.endpointCalls.every((entry) => entry.method === "POST") &&
    result.endpointCalls.filter((entry) => entry.status === 200).length === 3 &&
    result.endpointCalls.filter((entry) => entry.status === 204).length === 4 &&
    result.microphoneRequests === 0 &&
    result.peerCount === 3 &&
    result.peersClosed &&
    result.receivedAudioBeforeTeardown &&
    result.replacement.audioStarted &&
    result.replacement.statuses.every((status) => status === 204) &&
    result.toggleWasEnabledBeforeTeardown &&
    result.transceivers.length === 3 &&
    result.transceivers.every(
      (transceiver) => transceiver.kind === "audio" && transceiver.direction === "recvonly"
    ) &&
    consoleErrors.length === 0;

  console.log(JSON.stringify({
    passed,
    ...result,
    consoleErrors: consoleErrors.length
  }));
  if (!passed) {
    process.exitCode = 1;
  }
  await context.close();
} catch {
  let diagnostics = {};
  if (diagnosticsPage) {
    diagnostics = await diagnosticsPage.evaluate(() => {
      const smoke = window.__kbRealtimeSmoke;
      return {
        browserDataChannels: smoke?.dataChannelCreations ?? 0,
        endpointCalls: (smoke?.fetches ?? [])
          .filter((entry) =>
            entry.path === "/api/realtime-session" || entry.path === "/api/realtime-cue"
          )
          .map((entry) => ({ method: entry.method, status: entry.status })),
        peerCount: smoke?.peers?.length ?? 0,
        receivedAudioSessions: smoke?.receivedAudioSessions ?? 0,
        togglePressed:
          document.querySelector(".voice-coach-toggle")?.getAttribute("aria-pressed") ?? null,
        toggleTransport:
          document.querySelector(".voice-coach-toggle")?.getAttribute("data-transport") ?? null
      };
    }).catch(() => ({}));
  }
  console.log(JSON.stringify({ passed: false, stage, ...diagnostics }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
