const PREVIEW_HOST_PATTERN =
  /^kettlebellform-[a-z0-9-]+-sergiopeschs-projects\.vercel\.app$/i;
const BYPASS_COOKIE_NAME = "_vercel_jwt";

export function vercelPreviewOrigin(baseUrl) {
  let target;
  try {
    target = new URL(baseUrl);
  } catch {
    throw new Error("The protected Preview URL is invalid.");
  }

  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    !PREVIEW_HOST_PATTERN.test(target.hostname)
  ) {
    throw new Error("The protected Preview URL is not an approved KB FORM deployment.");
  }
  return target.origin;
}

export async function installVercelProtectionBypass(context, baseUrl, bypassToken) {
  const origin = vercelPreviewOrigin(baseUrl);
  if (
    typeof bypassToken !== "string" ||
    bypassToken.length === 0 ||
    bypassToken.length > 4_096 ||
    /[\r\n]/u.test(bypassToken)
  ) {
    throw new Error("The Preview protection credential is invalid.");
  }

  let response;
  try {
    response = await context.request.get(`${origin}/`, {
      headers: {
        "x-vercel-protection-bypass": bypassToken,
        "x-vercel-set-bypass-cookie": "true"
      },
      maxRedirects: 0,
      timeout: 15_000
    });

    const status = response.status();
    const location = response.headers().location;
    if (status < 300 || status >= 400 || !location) {
      throw new Error("The Preview protection bootstrap returned an unexpected response.");
    }

    let redirect;
    try {
      redirect = new URL(location, origin);
    } catch {
      throw new Error("The Preview protection bootstrap returned an invalid redirect.");
    }
    if (redirect.origin !== origin) {
      throw new Error("The Preview protection bootstrap attempted a cross-origin redirect.");
    }

    const expectedDomain = new URL(origin).hostname.toLowerCase();
    const cookies = await context.cookies(origin);
    const hasScopedBypassCookie = cookies.some((cookie) =>
      cookie.name === BYPASS_COOKIE_NAME &&
      cookie.domain.replace(/^\./u, "").toLowerCase() === expectedDomain &&
      cookie.path === "/" &&
      cookie.secure &&
      cookie.httpOnly &&
      (cookie.sameSite === "Lax" || cookie.sameSite === "Strict")
    );
    if (!hasScopedBypassCookie) {
      throw new Error("The Preview protection bootstrap did not create a scoped cookie.");
    }
  } finally {
    await response?.dispose?.();
  }
}
