import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";
import {
  createRealtimeSessionHandler,
  MAX_SDP_BYTES,
  REALTIME_SESSION_PATH,
  type RealtimeSessionEnvironment
} from "./server/realtimeSession";
import {
  createRealtimeCueHandler,
  MAX_REALTIME_CUE_BODY_BYTES,
  REALTIME_CUE_PATH
} from "./server/realtimeCue";

function localMediaPipeAssets(): Plugin {
  const publicAsset = (filename: string) =>
    fileURLToPath(new URL(`./public/vendor/mediapipe/0.10.35/${filename}`, import.meta.url));
  const assets = new Map([
    ["/@kb-mediapipe/vision_wasm_module_internal.js", {
      path: publicAsset("vision_wasm_module_internal.js"),
      contentType: "text/javascript; charset=utf-8"
    }],
    ["/@kb-mediapipe/vision_wasm_module_internal.wasm", {
      path: publicAsset("vision_wasm_module_internal.wasm"),
      contentType: "application/wasm"
    }]
  ]);

  return {
    name: "kb-form-local-mediapipe-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const asset = assets.get(pathname);
        if (!asset) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", asset.contentType);
        response.setHeader("Cache-Control", "no-store");
        createReadStream(asset.path).on("error", next).pipe(response);
      });
    }
  };
}

function localRealtimeApi(environment: RealtimeSessionEnvironment): Plugin {
  const handleRealtimeSession = createRealtimeSessionHandler({ environment });
  const handleRealtimeCue = createRealtimeCueHandler({ environment });

  return {
    name: "kb-form-local-realtime-session-api",
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        const requestUrl = new URL(incoming.url ?? "/", "http://127.0.0.1");
        const isSessionRequest = requestUrl.pathname === REALTIME_SESSION_PATH;
        const isCueRequest = requestUrl.pathname === REALTIME_CUE_PATH;
        if (!isSessionRequest && !isCueRequest) {
          next();
          return;
        }

        try {
          const maximumBodyBytes = isSessionRequest
            ? MAX_SDP_BYTES
            : MAX_REALTIME_CUE_BODY_BYTES;
          const chunks: Buffer[] = [];
          let byteLength = 0;
          let bodyTooLarge = false;
          for await (const rawChunk of incoming) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            byteLength += chunk.byteLength;
            if (byteLength > maximumBodyBytes) {
              bodyTooLarge = true;
            } else {
              chunks.push(chunk);
            }
          }

          if (bodyTooLarge) {
            outgoing.statusCode = 413;
            outgoing.setHeader("Cache-Control", "no-store, max-age=0");
            outgoing.setHeader("Content-Type", "application/json; charset=utf-8");
            outgoing.end(JSON.stringify({
              error: isSessionRequest
                ? "Realtime voice session request was not accepted."
                : "Realtime voice cue request was not accepted."
            }));
            return;
          }

          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              headers.set(name, value.join(", "));
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          if (!headers.has("x-forwarded-for")) {
            headers.set("x-forwarded-for", incoming.socket.remoteAddress ?? "local");
          }

          const host = incoming.headers.host ?? "127.0.0.1:5173";
          const protocol = (incoming.socket as typeof incoming.socket & { encrypted?: boolean })
            .encrypted
            ? "https:"
            : "http:";
          const request = new Request(`${protocol}//${host}${incoming.url ?? "/"}`, {
            method: incoming.method ?? "GET",
            headers,
            body:
              incoming.method === "GET" || incoming.method === "HEAD"
                ? undefined
                : Buffer.concat(chunks)
          });
          const response = await (isSessionRequest
            ? handleRealtimeSession(request)
            : handleRealtimeCue(request));
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => outgoing.setHeader(name, value));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          outgoing.statusCode = 500;
          outgoing.setHeader("Cache-Control", "no-store, max-age=0");
          outgoing.setHeader("Content-Type", "application/json; charset=utf-8");
          outgoing.end(JSON.stringify({ error: "Realtime voice is temporarily unavailable." }));
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const localEnvironment = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      localMediaPipeAssets(),
      localRealtimeApi(localEnvironment),
      react()
    ],
    server: {
      host: "127.0.0.1"
    },
    preview: {
      host: "127.0.0.1"
    },
    build: {
      target: "es2022",
      chunkSizeWarningLimit: 600
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts", "scripts/**/*.test.mjs"],
      setupFiles: ["./src/test/setup.ts"],
      css: true,
      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
        include: [
          "server/realtimeCue.ts",
          "server/realtimeSession.ts",
          "server/realtimeSessionToken.ts",
          "src/components/VideoClipWorkspace.tsx",
          "src/hooks/usePoseCoach.ts",
          "src/hooks/useSpokenFramingCoach.ts",
          "src/lib/coachVoicePolicy.ts",
          "src/lib/coachVoiceProfiles.ts",
          "src/lib/framingCoach.ts",
          "src/lib/realtimeVoiceClient.ts",
          "src/lib/swingAnalyzer.ts",
          "src/lib/videoClip.ts"
        ],
        thresholds: {
          statements: 70,
          branches: 60,
          functions: 70,
          lines: 70
        }
      }
    }
  };
});
