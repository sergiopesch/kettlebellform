import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TASKS_VERSION = "0.10.35";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const MODEL_SHA256 = "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1";

const runtimeSource = resolve("node_modules", "@mediapipe", "tasks-vision", "wasm");
const runtimeDestination = resolve("public", "vendor", "mediapipe", TASKS_VERSION);
const modelDestination = resolve(
  "public",
  "models",
  "pose_landmarker_full-float16-v1.task"
);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function ensureModel() {
  if ((await sha256(modelDestination).catch(() => "")) === MODEL_SHA256) {
    return;
  }

  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`Model download failed with HTTP ${response.status}.`);
  }

  const temporaryPath = `${modelDestination}.download`;
  await rm(temporaryPath, { force: true });
  await mkdir(dirname(modelDestination), { recursive: true });
  await writeFile(temporaryPath, new Uint8Array(await response.arrayBuffer()));

  const downloadedHash = await sha256(temporaryPath);
  if (downloadedHash !== MODEL_SHA256) {
    await rm(temporaryPath, { force: true });
    throw new Error(
      `Pose model integrity check failed: expected ${MODEL_SHA256}, received ${downloadedHash}.`
    );
  }

  await rename(temporaryPath, modelDestination);
}

await mkdir(runtimeDestination, { recursive: true });
await Promise.all(
  ["vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm"].map((file) =>
    copyFile(resolve(runtimeSource, file), resolve(runtimeDestination, file))
  )
);
await ensureModel();

console.log(`[model-assets] MediaPipe ${TASKS_VERSION} runtime and verified pose model are ready.`);
