import { describe, expect, it, vi } from "vitest";
import {
  installVercelProtectionBypass,
  vercelPreviewOrigin
} from "./protection-bypass.mjs";

const PREVIEW_URL =
  "https://kettlebellform-build123-sergiopeschs-projects.vercel.app";

function protectedContext({
  cookieDomain = "kettlebellform-build123-sergiopeschs-projects.vercel.app",
  cookieOverrides = {},
  location = `${PREVIEW_URL}/`,
  status = 307
} = {}) {
  const response = {
    dispose: vi.fn().mockResolvedValue(undefined),
    headers: vi.fn(() => ({ location })),
    status: vi.fn(() => status)
  };
  const context = {
    cookies: vi.fn().mockResolvedValue([{
      domain: cookieDomain,
      httpOnly: true,
      name: "_vercel_jwt",
      path: "/",
      sameSite: "Lax",
      secure: true,
      value: "not-inspected",
      ...cookieOverrides
    }]),
    request: {
      get: vi.fn().mockResolvedValue(response)
    }
  };
  return { context, response };
}

describe("protected Vercel Preview bootstrap", () => {
  it("sends the bypass token only to the validated Preview origin without following redirects", async () => {
    const { context, response } = protectedContext();

    await installVercelProtectionBypass(context, PREVIEW_URL, "preview-secret");

    expect(context.request.get).toHaveBeenCalledWith(`${PREVIEW_URL}/`, {
      headers: {
        "x-vercel-protection-bypass": "preview-secret",
        "x-vercel-set-bypass-cookie": "true"
      },
      maxRedirects: 0,
      timeout: 15_000
    });
    expect(context.cookies).toHaveBeenCalledWith(PREVIEW_URL);
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    "http://kettlebellform-build123-sergiopeschs-projects.vercel.app",
    "https://attacker.example",
    `${PREVIEW_URL}:8443`,
    `${PREVIEW_URL}/unexpected`,
    `${PREVIEW_URL}/?redirect=https://attacker.example`
  ])("rejects an unapproved protected target before sending the token: %s", async (target) => {
    const { context } = protectedContext();

    await expect(installVercelProtectionBypass(context, target, "preview-secret"))
      .rejects.toThrow("not an approved KB FORM deployment");
    expect(context.request.get).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin bootstrap redirect", async () => {
    const { context, response } = protectedContext({ location: "https://attacker.example/" });

    await expect(installVercelProtectionBypass(context, PREVIEW_URL, "preview-secret"))
      .rejects.toThrow("cross-origin redirect");
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a bypass cookie scoped beyond the exact Preview host", async () => {
    const { context, response } = protectedContext({ cookieDomain: ".vercel.app" });

    await expect(installVercelProtectionBypass(context, PREVIEW_URL, "preview-secret"))
      .rejects.toThrow("did not create a scoped cookie");
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["readable by page JavaScript", { httpOnly: false }],
    ["usable in cross-site requests", { sameSite: "None" }],
    ["scoped below the application root", { path: "/protected" }]
  ])("rejects a bypass cookie that is %s", async (_label, cookieOverrides) => {
    const { context, response } = protectedContext({ cookieOverrides });

    await expect(installVercelProtectionBypass(context, PREVIEW_URL, "preview-secret"))
      .rejects.toThrow("did not create a scoped cookie");
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it("rejects malformed credentials before sending a request", async () => {
    const { context } = protectedContext();

    await expect(installVercelProtectionBypass(context, PREVIEW_URL, "secret\r\nleak"))
      .rejects.toThrow("credential is invalid");
    expect(context.request.get).not.toHaveBeenCalled();
  });

  it("canonicalizes an approved Preview URL to its exact origin", () => {
    expect(vercelPreviewOrigin(`${PREVIEW_URL}/`)).toBe(PREVIEW_URL);
  });
});
