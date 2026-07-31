import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const DIST_ROOT = resolve("dist");
const KIB = 1024;
const MIB = 1024 * KIB;
const budgets = {
  initialJavaScript: 300 * KIB,
  individualJavaScript: 600 * KIB,
  totalOutput: 32 * MIB
};
const MODEL_SHA256 = "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : path;
    })
  );

  return files.flat();
}

function formatBytes(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function fail(message) {
  throw new Error(`[build:verify] ${message}`);
}

const requiredFiles = [
  "index.html",
  "_headers",
  "_redirects",
  "demo-swing.png",
  "demo-swing-overlay.png",
  "models/pose_landmarker_full-float16-v1.task",
  "vendor/mediapipe/0.10.35/vision_wasm_module_internal.js",
  "vendor/mediapipe/0.10.35/vision_wasm_module_internal.wasm"
];

await Promise.all(
  requiredFiles.map(async (file) => {
    const details = await stat(join(DIST_ROOT, file)).catch(() => null);
    if (!details?.isFile() || details.size === 0) {
      fail(`Required deployment file is missing or empty: dist/${file}`);
    }
  })
);

const files = await walk(DIST_ROOT);
const details = await Promise.all(
  files.map(async (file) => ({ file, size: (await stat(file)).size }))
);
const totalOutput = details.reduce((total, file) => total + file.size, 0);

const modelHash = createHash("sha256")
  .update(await readFile(join(DIST_ROOT, "models/pose_landmarker_full-float16-v1.task")))
  .digest("hex");
if (modelHash !== MODEL_SHA256) {
  fail(`Pose model integrity check failed: received ${modelHash}.`);
}

if (totalOutput > budgets.totalOutput) {
  fail(
    `Build output is ${formatBytes(totalOutput)}; budget is ${formatBytes(budgets.totalOutput)}.`
  );
}

const sourceMaps = details.filter(({ file }) => file.endsWith(".map"));
if (sourceMaps.length > 0) {
  fail(`Production source maps were emitted: ${sourceMaps.map(({ file }) => relative(DIST_ROOT, file)).join(", ")}`);
}

const JavaScriptFiles = details.filter(({ file }) => file.endsWith(".js"));
const oversizedJavaScript = JavaScriptFiles.filter(
  ({ size }) => size > budgets.individualJavaScript
);
if (oversizedJavaScript.length > 0) {
  fail(
    `JavaScript chunk budget exceeded: ${oversizedJavaScript
      .map(({ file, size }) => `${relative(DIST_ROOT, file)} (${formatBytes(size)})`)
      .join(", ")}`
  );
}

const indexHtml = await readFile(join(DIST_ROOT, "index.html"), "utf8");
const initialScripts = [...indexHtml.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/g)];
if (initialScripts.length !== 1) {
  fail(`Expected one initial JavaScript entry, found ${initialScripts.length}.`);
}

const initialScriptPath = join(
  DIST_ROOT,
  initialScripts[0][1].replace(/^\.\//, "").replace(/^\//, "")
);
const initialScriptSize = (await stat(initialScriptPath)).size;
if (initialScriptSize > budgets.initialJavaScript) {
  fail(
    `Initial JavaScript is ${formatBytes(initialScriptSize)}; budget is ${formatBytes(budgets.initialJavaScript)}.`
  );
}

const headers = await readFile(join(DIST_ROOT, "_headers"), "utf8");
for (const header of [
  "Content-Security-Policy:",
  "Permissions-Policy:",
  "Referrer-Policy:",
  "X-Content-Type-Options:"
]) {
  if (!headers.includes(header)) {
    fail(`Deployment headers are missing ${header}`);
  }
}

const vercel = JSON.parse(await readFile(resolve("vercel.json"), "utf8"));
if (vercel.outputDirectory !== "dist" || vercel.rewrites?.[0]?.destination !== "/index.html") {
  fail("vercel.json must publish dist and retain the SPA fallback.");
}

const globalVercelHeaders = vercel.headers?.find(({ source }) => source === "/(.*)")?.headers;
if (!Array.isArray(globalVercelHeaders)) {
  fail("vercel.json must define global deployment headers.");
}

const vercelHeaderNames = new Set(globalVercelHeaders.map(({ key }) => key));
for (const header of [
  "Content-Security-Policy",
  "Permissions-Policy",
  "Referrer-Policy",
  "X-Content-Type-Options"
]) {
  if (!vercelHeaderNames.has(header)) {
    fail(`vercel.json is missing ${header}.`);
  }
}

console.log(
  `[build:verify] OK — entry ${formatBytes(initialScriptSize)}, largest JS ${formatBytes(
    Math.max(...JavaScriptFiles.map(({ size }) => size))
  )}, output ${formatBytes(totalOutput)}.`
);
