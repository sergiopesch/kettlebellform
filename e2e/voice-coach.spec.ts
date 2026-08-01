import { expect, test, type Page } from "@playwright/test";

type SpeechProbeWindow = Window &
  typeof globalThis & {
    __KB_FORM_E2E_SPOKEN__: string[];
  };

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

test("voice profiles and AI disclosure remain usable at desktop and mobile widths", async ({
  page
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await expect(page).toHaveTitle(/KB FORM/i);
  await expect(page.getByRole("heading", { name: "Set up your camera" })).toBeVisible();
  const maleProfile = page.getByRole("button", {
    name: /British male command coach, AI-generated/i
  });
  const femaleProfile = page.getByRole("button", {
    name: /British female command coach, AI-generated/i
  });
  await expect(maleProfile).toHaveAttribute("aria-pressed", "false");
  await expect(femaleProfile).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".voice-ai-disclosure")).toContainText(
    "AI-generated speech, not a human coach recording"
  );
  await expect(page.locator(".privacy-line")).toContainText(
    /never microphone audio, camera frames, or landmarks/i
  );
  await expectNoHorizontalOverflow(page);
  await expectElementWithinViewportWidth(page, ".voice-coach-control");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Set up your camera" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /British male command coach, AI-generated/i })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /British female command coach, AI-generated/i })
  ).toBeVisible();
  await expect(page.locator(".voice-ai-disclosure")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectElementWithinViewportWidth(page, ".voice-coach-control");
  expect(pageErrors).toEqual([]);
});

test("on-device speech starts only after opt-in and never requests Realtime endpoints", async ({
  page
}) => {
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

    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: undefined
    });
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

  let realtimeSessionRequests = 0;
  let realtimeCueRequests = 0;
  await page.route("**/api/realtime-session**", async (route) => {
    realtimeSessionRequests += 1;
    await route.abort("blockedbyclient");
  });
  await page.route("**/api/realtime-cue", async (route) => {
    realtimeCueRequests += 1;
    await route.abort("blockedbyclient");
  });

  await page.goto("/");
  const toggle = page.getByRole("button", { name: /Voice framing coach/i });
  const maleProfile = page.getByRole("button", {
    name: /British male command coach, AI-generated/i
  });
  const femaleProfile = page.getByRole("button", {
    name: /British female command coach, AI-generated/i
  });

  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(() => (window as SpeechProbeWindow).__KB_FORM_E2E_SPOKEN__)
  ).toEqual([]);

  await maleProfile.click();
  await expect(maleProfile).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => (window as SpeechProbeWindow).__KB_FORM_E2E_SPOKEN__)
  ).toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("private device fallback");
  await expect
    .poll(() =>
      page.evaluate(() => (window as SpeechProbeWindow).__KB_FORM_E2E_SPOKEN__)
    )
    .toEqual(["Voice framing coach on."]);

  await femaleProfile.click();
  await expect(femaleProfile).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(() => (window as SpeechProbeWindow).__KB_FORM_E2E_SPOKEN__)
    )
    .toEqual(["Voice framing coach on.", "Female British coach selected."]);

  expect(realtimeSessionRequests).toBe(0);
  expect(realtimeCueRequests).toBe(0);
});
