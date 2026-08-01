// @vitest-environment node

import { describe, expect, it } from "vitest";
import realtimeCueRoute from "../api/realtime-cue";
import realtimeSessionRoute from "../api/realtime-session";

type FetchRoute = Readonly<{
  fetch(request: Request): Response | Promise<Response>;
}>;

const routes: ReadonlyArray<
  readonly [name: string, path: string, error: string, route: FetchRoute]
> = [
  [
    "Realtime session",
    "/api/realtime-session",
    "Realtime voice session request was not accepted.",
    realtimeSessionRoute
  ],
  [
    "Realtime cue",
    "/api/realtime-cue",
    "Realtime voice cue request was not accepted.",
    realtimeCueRoute
  ]
];

describe("Vercel Fetch API route adapters", () => {
  it.each(routes)("exports the %s route as a Fetch handler", async (
    _name,
    path,
    error,
    route
  ) => {
    expect(route).toEqual(expect.objectContaining({ fetch: expect.any(Function) }));

    const response = await route.fetch(new Request(`https://coach.example${path}`, {
      method: "GET"
    }));

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error });
  });
});
