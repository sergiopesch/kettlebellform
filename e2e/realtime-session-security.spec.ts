import { expect, test, type APIRequestContext } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";
async function expectGenericRejection(
  request: APIRequestContext,
  input: {
    path: string;
    method: "GET" | "POST";
    status: number;
    error: string;
    headers?: Record<string, string>;
    data?: string;
  }
) {
  const response = await request.fetch(input.path, {
    method: input.method,
    headers: input.headers,
    data: input.data
  });

  expect(response.status()).toBe(input.status);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect(response.json()).resolves.toEqual({ error: input.error });
  return response;
}

test("Realtime session route rejects requests before they are eligible for OpenAI", async ({
  request
}) => {
  const wrongMethod = await expectGenericRejection(request, {
    path: "/api/realtime-session?profile=female-command",
    method: "GET",
    status: 405,
    error: "Realtime voice session request was not accepted."
  });
  expect(wrongMethod.headers().allow).toBe("POST");

  await expectGenericRejection(request, {
    path: "/api/realtime-session?profile=female-command",
    method: "POST",
    status: 415,
    error: "Realtime voice session request was not accepted.",
    headers: {
      "Content-Type": "application/json"
    },
    data: "{}"
  });

  await expectGenericRejection(request, {
    path: "/api/realtime-session?profile=female-command",
    method: "POST",
    status: 403,
    error: "Realtime voice session request was not accepted.",
    headers: {
      "Content-Type": "application/sdp",
      Origin: "https://attacker.invalid",
      "Sec-Fetch-Site": "cross-site"
    },
    data: "v=0\r\n"
  });

  await expectGenericRejection(request, {
    path: "/api/realtime-session?profile=unrecognised",
    method: "POST",
    status: 400,
    error: "Realtime voice session request was not accepted.",
    headers: {
      "Content-Type": "application/sdp",
      Origin: baseURL,
      "Sec-Fetch-Site": "same-origin"
    },
    data: "v=0\r\n"
  });
});

test("Realtime cue route rejects untrusted or unsigned commands before sideband use", async ({
  request
}) => {
  const genericCueError = "Realtime voice cue request was not accepted.";
  const wrongMethod = await expectGenericRejection(request, {
    path: "/api/realtime-cue",
    method: "GET",
    status: 405,
    error: genericCueError
  });
  expect(wrongMethod.headers().allow).toBe("POST");

  await expectGenericRejection(request, {
    path: "/api/realtime-cue",
    method: "POST",
    status: 415,
    error: genericCueError,
    headers: {
      "Content-Type": "text/plain"
    },
    data: "ready"
  });

  await expectGenericRejection(request, {
    path: "/api/realtime-cue",
    method: "POST",
    status: 403,
    error: genericCueError,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid",
      "Sec-Fetch-Site": "cross-site"
    },
    data: JSON.stringify({ action: "speak", cueId: "ready" })
  });

  await expectGenericRejection(request, {
    path: "/api/realtime-cue",
    method: "POST",
    status: 403,
    error: genericCueError,
    headers: {
      "Content-Type": "application/json",
      Origin: baseURL,
      "Sec-Fetch-Site": "same-origin"
    },
    data: JSON.stringify({ action: "speak", cueId: "ready" })
  });
});
