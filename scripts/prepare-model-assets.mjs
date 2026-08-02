import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TASKS_VERSION = "0.10.35";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const MODEL_SHA256 = "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1";
const MODEL_EXPECTED_BYTES = 9_398_198;
const MODEL_MAX_BYTES = MODEL_EXPECTED_BYTES;
const MODEL_DOWNLOAD_TIMEOUT_MS = 60_000;
const MODEL_DOWNLOAD_ORPHAN_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;
const MODEL_DOWNLOAD_CLEANUP_ENTRY_LIMIT = 512;
const MODEL_DOWNLOAD_CLEANUP_REMOVAL_LIMIT = 16;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function abortReason(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Model download was aborted.");
}

async function waitWithSignal(operation, signal) {
  if (signal.aborted) {
    throw abortReason(signal);
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function declaredContentLength(response, maximumBytes) {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null) {
    return null;
  }
  const normalized = rawLength.trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    throw new Error("Model response has an invalid Content-Length header.");
  }
  const length = Number(normalized);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new Error(
      `Model response declares ${normalized} bytes, above the ${maximumBytes}-byte limit.`
    );
  }
  return length;
}

async function writeCompleteChunk(fileHandle, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await fileHandle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null
    );
    if (bytesWritten <= 0) {
      throw new Error("Writing the pose model made no progress.");
    }
    offset += bytesWritten;
  }
}

function validateDownloadLimits({ expectedBytes, maximumBytes, timeoutMs }) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < expectedBytes ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("Pose model download limits are invalid.");
  }
}

function temporaryDownloadPath(destination, pid = process.pid, uuid = randomUUID()) {
  return `${destination}.download-${pid}-${uuid}`;
}

function ownedDownloadPid(name, prefix) {
  if (!name.startsWith(prefix)) {
    return null;
  }
  const ownership = name.slice(prefix.length);
  const separator = ownership.indexOf("-");
  if (separator <= 0) {
    return null;
  }

  const rawPid = ownership.slice(0, separator);
  const uuid = ownership.slice(separator + 1);
  if (!/^[1-9]\d{0,9}$/u.test(rawPid) || !UUID_V4_PATTERN.test(uuid)) {
    return null;
  }

  const pid = Number(rawPid);
  return Number.isSafeInteger(pid) && pid <= 2_147_483_647 ? pid : null;
}

function localProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function safeLstat(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

export async function cleanupAbandonedModelDownloads(destination, {
  isProcessAlive = localProcessIsAlive,
  minimumAgeMs = MODEL_DOWNLOAD_ORPHAN_MINIMUM_AGE_MS,
  nowMs = Date.now()
} = {}) {
  if (
    typeof isProcessAlive !== "function" ||
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(minimumAgeMs) ||
    minimumAgeMs < MODEL_DOWNLOAD_ORPHAN_MINIMUM_AGE_MS
  ) {
    throw new Error("Pose model orphan-cleanup limits are invalid.");
  }

  const parent = dirname(destination);
  let directory;
  try {
    directory = await opendir(parent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const prefix = `${basename(destination)}.download-`;
  const staleBeforeMs = nowMs - minimumAgeMs;
  let inspectedEntries = 0;
  let removedFiles = 0;

  try {
    while (
      inspectedEntries < MODEL_DOWNLOAD_CLEANUP_ENTRY_LIMIT &&
      removedFiles < MODEL_DOWNLOAD_CLEANUP_REMOVAL_LIMIT
    ) {
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      inspectedEntries += 1;

      const pid = ownedDownloadPid(entry.name, prefix);
      if (pid === null) {
        continue;
      }

      const candidate = join(parent, entry.name);
      const firstMetadata = await safeLstat(candidate);
      if (
        !firstMetadata?.isFile() ||
        firstMetadata.nlink !== 1 ||
        !Number.isFinite(firstMetadata.mtimeMs) ||
        firstMetadata.mtimeMs >= staleBeforeMs
      ) {
        continue;
      }

      let processAlive;
      try {
        processAlive = await isProcessAlive(pid);
      } catch {
        continue;
      }
      if (processAlive !== false) {
        continue;
      }

      const currentMetadata = await safeLstat(candidate);
      if (
        !currentMetadata?.isFile() ||
        currentMetadata.nlink !== 1 ||
        currentMetadata.dev !== firstMetadata.dev ||
        currentMetadata.ino !== firstMetadata.ino ||
        !Number.isFinite(currentMetadata.mtimeMs) ||
        currentMetadata.mtimeMs >= staleBeforeMs
      ) {
        continue;
      }

      try {
        await unlink(candidate);
        removedFiles += 1;
      } catch {
        // A concurrent owner or cleanup may have changed the path; leave it alone.
      }
    }
  } finally {
    await directory.close();
  }

  return removedFiles;
}

export async function downloadVerifiedModel({
  destination,
  expectedBytes,
  expectedSha256,
  fetchImpl = globalThis.fetch,
  maximumBytes,
  modelUrl,
  timeoutMs
}) {
  validateDownloadLimits({ expectedBytes, maximumBytes, timeoutMs });
  if (typeof fetchImpl !== "function") {
    throw new Error("A model download implementation is unavailable.");
  }

  const temporaryPath = temporaryDownloadPath(destination);
  await mkdir(dirname(destination), { recursive: true });

  const controller = new AbortController();
  const timeoutError = new Error(`Model download timed out after ${timeoutMs} ms.`);
  let deadlineHandle = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let fileHandle = null;
  let reader = null;

  try {
    const response = await waitWithSignal(
      Promise.resolve().then(() =>
        fetchImpl(modelUrl, {
          redirect: "error",
          signal: controller.signal
        })
      ),
      controller.signal
    );
    if (response.redirected) {
      throw new Error("Model download redirects are not allowed.");
    }
    if (!response.ok) {
      throw new Error(`Model download failed with HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new Error("Model download returned no response body.");
    }
    declaredContentLength(response, maximumBytes);

    reader = response.body.getReader();
    fileHandle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await waitWithSignal(reader.read(), controller.signal);
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("Model response returned a non-byte chunk.");
      }
      if (value.byteLength > maximumBytes - receivedBytes) {
        const sizeError = new Error(
          `Model response exceeded the ${maximumBytes}-byte limit.`
        );
        controller.abort(sizeError);
        throw sizeError;
      }

      receivedBytes += value.byteLength;
      hash.update(value);
      await writeCompleteChunk(fileHandle, value);
      if (controller.signal.aborted) {
        throw abortReason(controller.signal);
      }
    }

    clearTimeout(deadlineHandle);
    deadlineHandle = null;
    reader.releaseLock();
    reader = null;

    if (receivedBytes !== expectedBytes) {
      throw new Error(
        `Pose model length check failed: expected ${expectedBytes} bytes, received ${receivedBytes}.`
      );
    }
    const downloadedHash = hash.digest("hex");
    if (downloadedHash !== expectedSha256) {
      throw new Error(
        `Pose model integrity check failed: expected ${expectedSha256}, received ${downloadedHash}.`
      );
    }

    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    await rename(temporaryPath, destination);
  } catch (error) {
    const failure = controller.signal.aborted ? abortReason(controller.signal) : error;
    if (!controller.signal.aborted) {
      controller.abort(failure);
    }
    const cancelOperation = reader?.cancel(failure);
    void cancelOperation?.catch(() => {});

    const cleanupErrors = [];
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      fileHandle = null;
    }
    try {
      await rm(temporaryPath, { force: true });
    } catch (removeError) {
      cleanupErrors.push(removeError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupErrors],
        "Model download failed and its temporary file could not be cleaned safely."
      );
    }
    throw failure;
  } finally {
    if (deadlineHandle !== null) {
      clearTimeout(deadlineHandle);
    }
    try {
      reader?.releaseLock();
    } catch {
      // Cancellation owns the pending read; the temporary file is already closed and removed.
    }
  }
}

export async function ensureModelAsset({
  destination = modelDestination,
  expectedBytes = MODEL_EXPECTED_BYTES,
  expectedSha256 = MODEL_SHA256,
  fetchImpl = globalThis.fetch,
  maximumBytes = MODEL_MAX_BYTES,
  modelUrl = MODEL_URL,
  timeoutMs = MODEL_DOWNLOAD_TIMEOUT_MS
} = {}) {
  await cleanupAbandonedModelDownloads(destination);
  if ((await sha256(destination).catch(() => "")) === expectedSha256) {
    return "cached";
  }

  await downloadVerifiedModel({
    destination,
    expectedBytes,
    expectedSha256,
    fetchImpl,
    maximumBytes,
    modelUrl,
    timeoutMs
  });
  return "downloaded";
}

async function ensureModel() {
  await ensureModelAsset();
}

export async function prepareModelAssets() {
  await mkdir(runtimeDestination, { recursive: true });
  await Promise.all(
    ["vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm"].map((file) =>
      copyFile(resolve(runtimeSource, file), resolve(runtimeDestination, file))
    )
  );
  await ensureModel();
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await prepareModelAssets();
  console.log(`[model-assets] MediaPipe ${TASKS_VERSION} runtime and verified pose model are ready.`);
}
