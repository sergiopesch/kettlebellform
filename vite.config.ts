import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

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

export default defineConfig({
  plugins: [localMediaPipeAssets(), react()],
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
    maxWorkers: 2,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/components/VideoClipWorkspace.tsx",
        "src/hooks/usePoseCoach.ts",
        "src/hooks/useSpokenFramingCoach.ts",
        "src/lib/coachVoiceAssets.ts",
        "src/lib/coachVoicePackClient.ts",
        "src/lib/coachVoicePolicy.ts",
        "src/lib/coachVoiceProfiles.ts",
        "src/lib/framingCoach.ts",
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
});
