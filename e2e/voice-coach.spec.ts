import { expect, test, type Page, type Request } from "@playwright/test";

type SpeechProbeWindow = Window &
  typeof globalThis & {
    __KB_FORM_E2E_SPOKEN__: string[];
  };

type FirefoxAudioProbeWindow = Window &
  typeof globalThis & {
    __KB_FORM_E2E_RELEASE_AUDIO__: () => void;
  };

async function installFirefoxAudioContextStub(page: Page) {
  await page.addInitScript(() => {
    let releaseAudio!: () => void;
    const audioRelease = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });

    class E2EAudioContext {
      state: AudioContextState = "suspended";
      currentTime = 0;
      destination = {} as AudioDestinationNode;

      async resume() {
        this.state = "running";
      }

      async suspend() {
        this.state = "suspended";
      }

      async close() {
        this.state = "closed";
      }

      async decodeAudioData() {
        await audioRelease;
        return { duration: 1 } as AudioBuffer;
      }

      createBufferSource() {
        const source = {
          buffer: null as AudioBuffer | null,
          onended: null as (() => void) | null,
          connect() {},
          disconnect() {},
          start() {
            queueMicrotask(() => source.onended?.());
          },
          stop() {
            queueMicrotask(() => source.onended?.());
          }
        };
        return source as unknown as AudioBufferSourceNode;
      }

      createGain() {
        return {
          gain: {
            value: 1,
            cancelScheduledValues() {},
            setValueAtTime() {},
            linearRampToValueAtTime() {}
          },
          connect() {},
          disconnect() {}
        } as unknown as GainNode;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: E2EAudioContext
    });
    Object.defineProperty(window, "__KB_FORM_E2E_RELEASE_AUDIO__", {
      configurable: false,
      value: releaseAudio
    });
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectElementWithinViewportWidth(page: Page, selector: string) {
  const viewport = page.viewportSize();
  const box = await page.locator(selector).boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(
  foreground: [number, number, number],
  background: [number, number, number]
): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbChannels(cssColor: string): [number, number, number] {
  const channels = cssColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) {
    throw new Error(`Expected an RGB colour, received ${cssColor}`);
  }
  return channels as [number, number, number];
}

const maleProfileName = /British male Maritime Command coach, AI-generated/i;
const femaleProfileName = /British female Maritime Command coach, AI-generated/i;

test("voice profiles and disclosure remain usable at desktop and mobile widths", async ({
  page,
  browserName
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await expect(page).toHaveTitle(/KB FORM/i);
  await expect(page.getByRole("heading", { name: "Set up your camera" })).toBeVisible();
  const maleProfile = page.getByRole("button", { name: maleProfileName });
  const femaleProfile = page.getByRole("button", { name: femaleProfileName });
  await expect(maleProfile).toHaveAttribute("aria-pressed", "false");
  await expect(femaleProfile).toHaveAttribute("aria-pressed", "true");
  await expect(femaleProfile.locator(".selection-check")).toBeVisible();
  await expect(maleProfile.locator(".selection-check")).toHaveCount(0);
  await expect(page.locator(".voice-ai-disclosure")).toContainText(
    "Original AI-generated character voices"
  );
  await expect(page.locator(".voice-ai-disclosure")).toContainText(
    "not affiliated with any military unit"
  );
  await expect(page.locator(".privacy-line")).toContainText(
    /never uploads microphone audio, camera frames, clips, or landmarks/i
  );
  await expectNoHorizontalOverflow(page);
  await expectElementWithinViewportWidth(page, ".voice-coach-control");

  const primaryColours = await page.locator(".button-primary").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  expect(
    contrastRatio(rgbChannels(primaryColours.foreground), rgbChannels(primaryColours.background))
  ).toBeGreaterThanOrEqual(4.5);

  const roomView = page.getByRole("button", { name: /Room view/i });
  await expect(roomView.locator(".selection-check")).toBeVisible();
  if (browserName === "chromium") {
    const selfieView = page.getByRole("button", { name: /Selfie view/i });
    await roomView.focus();
    await page.keyboard.press("Tab");
    await expect(selfieView).toBeFocused();
    const focusStyle = await selfieView.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth
      };
    });
    expect(focusStyle.outlineStyle).toBe("solid");
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(rgbChannels(focusStyle.outlineColor), [5, 5, 5])).toBeGreaterThanOrEqual(3);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Set up your camera" })).toBeVisible();
  await expect(page.getByRole("button", { name: maleProfileName })).toBeVisible();
  await expect(page.getByRole("button", { name: femaleProfileName })).toBeVisible();
  await expect(
    page.getByRole("button", { name: femaleProfileName }).locator(".selection-check")
  ).toBeVisible();
  await expect(page.locator(".voice-ai-disclosure")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectElementWithinViewportWidth(page, ".voice-coach-control");
  expect(pageErrors).toEqual([]);
});

test("the verified voice pack loads only after opt-in and never calls a speech provider", async ({
  page,
  browserName
}) => {
  const voiceAssets: Request[] = [];
  const forbiddenRequests: string[] = [];
  const failedRequests: Request[] = [];
  const pageErrors: Error[] = [];
  if (browserName === "firefox") {
    await installFirefoxAudioContextStub(page);
  }
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("requestfailed", (request) => failedRequests.push(request));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\.mp3(?:\?|$)/.test(url.pathname)) {
      voiceAssets.push(request);
    }
    if (
      /(?:^|\.)openai\.com$/.test(url.hostname) ||
      /(?:^|\.)huggingface\.co$/.test(url.hostname) ||
      /(?:^|\.)hf\.space$/.test(url.hostname) ||
      url.pathname === "/api/realtime-session" ||
      url.pathname === "/api/realtime-cue"
    ) {
      forbiddenRequests.push(request.url());
    }
  });

  await page.goto("/");
  const toggle = page.getByRole("button", { name: /Voice framing coach/i });
  const maleProfile = page.getByRole("button", { name: maleProfileName });
  const femaleProfile = page.getByRole("button", { name: femaleProfileName });

  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(voiceAssets).toHaveLength(0);

  await maleProfile.click();
  await expect(maleProfile).toHaveAttribute("aria-pressed", "true");
  expect(voiceAssets).toHaveLength(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  if (browserName === "firefox") {
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    await expect(toggle).toContainText("Voice framing coach");
    await expect(toggle).toContainText("Loading the verified Maritime Command voice pack…");
    await page.evaluate(() =>
      (window as FirefoxAudioProbeWindow).__KB_FORM_E2E_RELEASE_AUDIO__()
    );
  }
  await expect(toggle).toHaveAttribute("aria-busy", "false");
  await expect(toggle).toContainText("verified voice pack");
  await expect.poll(() => voiceAssets.length).toBe(11);
  expect(new Set(voiceAssets.map((request) => request.url())).size).toBe(11);

  await femaleProfile.click();
  await expect(femaleProfile).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("verified voice pack");
  await expect.poll(() => voiceAssets.length).toBe(22);
  expect(new Set(voiceAssets.map((request) => request.url())).size).toBe(22);
  expect(forbiddenRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("a failed branded asset degrades to the disclosed local fallback", async ({ page }) => {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    const voice = {
      default: true,
      lang: "en-GB",
      localService: true,
      name: "E2E British device voice",
      voiceURI: "e2e-device-voice"
    } as SpeechSynthesisVoice;

    class E2ESpeechSynthesisUtterance {
      voice: SpeechSynthesisVoice | null = null;
      lang = "";
      rate = 1;
      pitch = 1;
      volume = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(public text: string) {}
    }

    const synthesis = {
      cancel() {},
      getVoices: () => [voice],
      speak(utterance: E2ESpeechSynthesisUtterance) {
        spoken.push(utterance.text);
        queueMicrotask(() => utterance.onend?.());
      },
      addEventListener() {},
      removeEventListener() {}
    };

    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: E2ESpeechSynthesisUtterance
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: synthesis
    });
    Object.defineProperty(window, "__KB_FORM_E2E_SPOKEN__", {
      configurable: false,
      value: spoken
    });
  });
  await page.route("**/*.mp3*", async (route) => {
    await route.fulfill({ status: 404, body: "missing" });
  });

  await page.goto("/");
  const toggle = page.getByRole("button", { name: /Voice framing coach/i });
  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("local device fallback");
  await expect(toggle).toContainText("privacy may vary");
  await expect(page.getByRole("button", { name: maleProfileName })).toBeDisabled();
  await expect(page.getByRole("button", { name: femaleProfileName })).toBeDisabled();
  await expect(page.locator(".inline-status")).toContainText(
    "browser-reported local English voice"
  );
  expect(
    await page.evaluate(() => (window as SpeechProbeWindow).__KB_FORM_E2E_SPOKEN__)
  ).toEqual([]);
});
