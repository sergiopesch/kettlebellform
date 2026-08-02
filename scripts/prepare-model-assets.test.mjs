import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupAbandonedModelDownloads,
  downloadVerifiedModel,
  ensureModelAsset
} from "./prepare-model-assets.mjs";

const TEST_MODEL_URL = "https://models.example/pose.task";
const TEST_ORPHAN_NOW_MS = Date.UTC(2026, 7, 2, 12);
const TEST_ORPHAN_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTemporaryModel(run) {
  const root = await mkdtemp(join(tmpdir(), "kb-form-model-assets-"));
  const destination = join(root, "pose.task");
  try {
    await run({ destination });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function responseFromChunks(chunks, {
  cancel,
  close = true,
  contentLength
} = {}) {
  const headers = new Headers();
  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }
  const body = new ReadableStream({
    cancel,
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (close) {
        controller.close();
      }
    }
  });
  return new Response(body, { headers, status: 200 });
}

function boundedOptions(destination, expected, overrides = {}) {
  return {
    destination,
    expectedBytes: expected.byteLength,
    expectedSha256: digest(expected),
    fetchImpl: vi.fn(async () => responseFromChunks([expected], {
      contentLength: String(expected.byteLength)
    })),
    maximumBytes: expected.byteLength,
    modelUrl: TEST_MODEL_URL,
    timeoutMs: 1_000,
    ...overrides
  };
}

async function expectMissing(path) {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function temporaryDownloadPaths(destination) {
  const parent = dirname(destination);
  const prefix = `${basename(destination)}.download-`;
  return (await readdir(parent))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name));
}

async function expectNoTemporaryDownloads(destination) {
  expect(await temporaryDownloadPaths(destination)).toEqual([]);
}

function ownedTemporaryPath(destination, pid, serial) {
  const uuid = `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
  return `${destination}.download-${pid}-${uuid}`;
}

async function makeStale(path) {
  const staleTime = (TEST_ORPHAN_NOW_MS - TEST_ORPHAN_MINIMUM_AGE_MS * 2) / 1_000;
  await utimes(path, staleTime, staleTime);
}

async function waitForTemporaryContents(destination, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidates = await temporaryDownloadPaths(destination);
    for (const path of candidates) {
      const contents = await readFile(path).catch(() => null);
      if (contents?.equals(Buffer.from(expected))) {
        return path;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error("Timed out waiting for the expected temporary model contents.");
}

describe("abandoned pose-model temp cleanup", () => {
  it("deletes a stale orphan only after its owning process is confirmed dead", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const staleOrphan = ownedTemporaryPath(destination, 41_001, 1);
      await writeFile(staleOrphan, "partial model");
      await makeStale(staleOrphan);
      const isProcessAlive = vi.fn((pid) => {
        expect(pid).toBe(41_001);
        return false;
      });

      await expect(cleanupAbandonedModelDownloads(destination, {
        isProcessAlive,
        minimumAgeMs: TEST_ORPHAN_MINIMUM_AGE_MS,
        nowMs: TEST_ORPHAN_NOW_MS
      })).resolves.toBe(1);

      expect(isProcessAlive).toHaveBeenCalledOnce();
      await expectMissing(staleOrphan);
    });
  });

  it("runs orphan cleanup before accepting an already cached model", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const expected = new Uint8Array([7, 7, 7, 7]);
      const staleOrphan = ownedTemporaryPath(destination, 41_006, 6);
      await writeFile(destination, expected);
      await writeFile(staleOrphan, "partial model");
      await makeStale(staleOrphan);
      const noSuchProcess = Object.assign(new Error("no such process"), {
        code: "ESRCH"
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect([pid, signal]).toEqual([41_006, 0]);
        throw noSuchProcess;
      });

      try {
        await expect(ensureModelAsset(boundedOptions(destination, expected)))
          .resolves.toBe("cached");
      } finally {
        kill.mockRestore();
      }

      await expectMissing(staleOrphan);
      await expect(readFile(destination)).resolves.toEqual(Buffer.from(expected));
    });
  });

  it("preserves active, recent, symlinked, hard-linked, and unrelated paths", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const active = ownedTemporaryPath(destination, process.pid, 2);
      const recent = ownedTemporaryPath(destination, 41_002, 3);
      const symlinkTarget = join(dirname(destination), "keep-target");
      const symlinked = ownedTemporaryPath(destination, 41_003, 4);
      const hardlinked = ownedTemporaryPath(destination, 41_007, 7);
      const unrelated = `${destination}.download-41004-not-a-runtime-uuid`;
      const lookalike = `${ownedTemporaryPath(destination, 41_005, 5)}.backup`;

      await Promise.all([
        writeFile(active, "active"),
        writeFile(recent, "recent"),
        writeFile(symlinkTarget, "target"),
        writeFile(unrelated, "unrelated"),
        writeFile(lookalike, "lookalike")
      ]);
      await symlink(symlinkTarget, symlinked);
      await link(symlinkTarget, hardlinked);
      await Promise.all([
        makeStale(active),
        makeStale(symlinkTarget),
        makeStale(unrelated),
        makeStale(lookalike)
      ]);
      const recentTime = (TEST_ORPHAN_NOW_MS - 60 * 60 * 1_000) / 1_000;
      await utimes(recent, recentTime, recentTime);

      await expect(cleanupAbandonedModelDownloads(destination, {
        minimumAgeMs: TEST_ORPHAN_MINIMUM_AGE_MS,
        nowMs: TEST_ORPHAN_NOW_MS
      })).resolves.toBe(0);

      await expect(readFile(active, "utf8")).resolves.toBe("active");
      await expect(readFile(recent, "utf8")).resolves.toBe("recent");
      expect((await lstat(symlinked)).isSymbolicLink()).toBe(true);
      await expect(readlink(symlinked)).resolves.toBe(symlinkTarget);
      await expect(readFile(hardlinked, "utf8")).resolves.toBe("target");
      await expect(readFile(symlinkTarget, "utf8")).resolves.toBe("target");
      await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
      await expect(readFile(lookalike, "utf8")).resolves.toBe("lookalike");
    });
  });

  it("bounds stale-file removals per invocation", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const staleOrphans = Array.from({ length: 17 }, (_, index) =>
        ownedTemporaryPath(destination, 42_000 + index, 100 + index)
      );
      for (const staleOrphan of staleOrphans) {
        await writeFile(staleOrphan, "partial model");
        await makeStale(staleOrphan);
      }

      await expect(cleanupAbandonedModelDownloads(destination, {
        isProcessAlive: () => false,
        minimumAgeMs: TEST_ORPHAN_MINIMUM_AGE_MS,
        nowMs: TEST_ORPHAN_NOW_MS
      })).resolves.toBe(16);

      const survivors = await Promise.all(
        staleOrphans.map((path) => stat(path).then(() => path, () => null))
      );
      expect(survivors.filter(Boolean)).toHaveLength(1);
    });
  });
});

describe("bounded pose-model download", () => {
  it("aborts an open response body at the caller-owned deadline and removes the partial file", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const cancelled = vi.fn();
      const prefix = new Uint8Array([1, 2, 3]);
      const fetchImpl = vi.fn(async (_url, options) => {
        expect(options.redirect).toBe("error");
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return responseFromChunks([prefix], { cancel: cancelled, close: false });
      });

      await expect(downloadVerifiedModel({
        destination,
        expectedBytes: prefix.byteLength,
        expectedSha256: digest(prefix),
        fetchImpl,
        maximumBytes: prefix.byteLength,
        modelUrl: TEST_MODEL_URL,
        timeoutMs: 30
      })).rejects.toThrow("timed out after 30 ms");

      expect(cancelled).toHaveBeenCalledOnce();
      await expectNoTemporaryDownloads(destination);
      await expectMissing(destination);
    });
  });

  it.each([
    ["absent", undefined],
    ["misleadingly small", "1"]
  ])("enforces the actual-byte ceiling when Content-Length is %s", async (_label, contentLength) => {
    await withTemporaryModel(async ({ destination }) => {
      const allowed = new Uint8Array([1, 2, 3, 4]);
      const oversized = new Uint8Array([1, 2, 3, 4, 5]);

      await expect(downloadVerifiedModel(boundedOptions(destination, allowed, {
        fetchImpl: vi.fn(async () =>
          responseFromChunks([oversized], { contentLength })
        )
      }))).rejects.toThrow("exceeded the 4-byte limit");

      await expectNoTemporaryDownloads(destination);
      await expectMissing(destination);
    });
  });

  it("stops an over-limit chunked body before writing the crossing chunk", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const cancelled = vi.fn();
      const expected = new Uint8Array(5);
      const fetchImpl = vi.fn(async () => responseFromChunks(
        [new Uint8Array(3), new Uint8Array(3)],
        { cancel: cancelled, close: false }
      ));

      await expect(downloadVerifiedModel(boundedOptions(destination, expected, {
        fetchImpl
      }))).rejects.toThrow("exceeded the 5-byte limit");

      expect(cancelled).toHaveBeenCalledOnce();
      await expectNoTemporaryDownloads(destination);
      await expectMissing(destination);
    });
  });

  it("rejects an oversized declared length before acquiring a body reader", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const getReader = vi.fn();
      const fetchImpl = vi.fn(async () => ({
        body: { getReader },
        headers: new Headers({ "content-length": "6" }),
        ok: true,
        redirected: false,
        status: 200
      }));

      await expect(downloadVerifiedModel({
        destination,
        expectedBytes: 5,
        expectedSha256: "0".repeat(64),
        fetchImpl,
        maximumBytes: 5,
        modelUrl: TEST_MODEL_URL,
        timeoutMs: 1_000
      })).rejects.toThrow("above the 5-byte limit");

      expect(getReader).not.toHaveBeenCalled();
      await expectNoTemporaryDownloads(destination);
    });
  });

  it("rejects redirects even when an injected fetch returns a successful response", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const fetchImpl = vi.fn(async (_url, options) => {
        expect(options.redirect).toBe("error");
        return {
          body: responseFromChunks([new Uint8Array([1])]).body,
          headers: new Headers({ "content-length": "1" }),
          ok: true,
          redirected: true,
          status: 200
        };
      });

      await expect(downloadVerifiedModel({
        destination,
        expectedBytes: 1,
        expectedSha256: digest(new Uint8Array([1])),
        fetchImpl,
        maximumBytes: 1,
        modelUrl: TEST_MODEL_URL,
        timeoutMs: 1_000
      })).rejects.toThrow("redirects are not allowed");

      await expectNoTemporaryDownloads(destination);
      await expectMissing(destination);
    });
  });

  it("removes a bounded digest mismatch without replacing an existing destination", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const downloaded = new Uint8Array([4, 3, 2, 1]);
      await writeFile(destination, "existing");

      await expect(downloadVerifiedModel({
        destination,
        expectedBytes: downloaded.byteLength,
        expectedSha256: "0".repeat(64),
        fetchImpl: vi.fn(async () => responseFromChunks([downloaded], {
          contentLength: String(downloaded.byteLength)
        })),
        maximumBytes: downloaded.byteLength,
        modelUrl: TEST_MODEL_URL,
        timeoutMs: 1_000
      })).rejects.toThrow("integrity check failed");

      await expectNoTemporaryDownloads(destination);
      await expect(readFile(destination, "utf8")).resolves.toBe("existing");
    });
  });

  it("keeps the destination unchanged until a valid bounded body is atomically promoted", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const first = new Uint8Array([1, 2, 3]);
      const second = new Uint8Array([4, 5, 6]);
      const expected = new Uint8Array([...first, ...second]);
      let bodyController;
      const response = new Response(new ReadableStream({
        start(controller) {
          bodyController = controller;
          controller.enqueue(first);
        }
      }), {
        headers: { "content-length": String(expected.byteLength) },
        status: 200
      });
      await writeFile(destination, "existing");

      const download = ensureModelAsset(boundedOptions(destination, expected, {
        fetchImpl: vi.fn(async () => response)
      }));
      await waitForTemporaryContents(destination, first);
      await expect(readFile(destination, "utf8")).resolves.toBe("existing");

      bodyController.enqueue(second);
      bodyController.close();
      await expect(download).resolves.toBe("downloaded");

      await expect(readFile(destination)).resolves.toEqual(Buffer.from(expected));
      await expectNoTemporaryDownloads(destination);
    });
  });

  it("never promotes another invocation's partial pathname during concurrent downloads", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const validPrefix = new Uint8Array([1, 2, 3]);
      const validSuffix = new Uint8Array([4, 5, 6]);
      const expected = new Uint8Array([...validPrefix, ...validSuffix]);
      const invalidPrefix = new Uint8Array([9, 9, 9]);
      const invalidSuffix = new Uint8Array([8, 8, 8]);
      let validController;
      let invalidController;

      const validResponse = new Response(new ReadableStream({
        start(controller) {
          validController = controller;
          controller.enqueue(validPrefix);
        }
      }), {
        headers: { "content-length": String(expected.byteLength) },
        status: 200
      });
      const invalidResponse = new Response(new ReadableStream({
        start(controller) {
          invalidController = controller;
          controller.enqueue(invalidPrefix);
        }
      }), {
        headers: { "content-length": String(expected.byteLength) },
        status: 200
      });

      const validDownload = downloadVerifiedModel(boundedOptions(destination, expected, {
        fetchImpl: vi.fn(async () => validResponse)
      }));
      const validTemporaryPath = await waitForTemporaryContents(
        destination,
        validPrefix
      );

      const invalidDownload = downloadVerifiedModel(boundedOptions(destination, expected, {
        fetchImpl: vi.fn(async () => invalidResponse)
      }));
      const invalidTemporaryPath = await waitForTemporaryContents(
        destination,
        invalidPrefix
      );
      expect(invalidTemporaryPath).not.toBe(validTemporaryPath);

      validController.enqueue(validSuffix);
      validController.close();
      await expect(validDownload).resolves.toBeUndefined();
      const contentsAfterValidPromotion = await readFile(destination);

      invalidController.enqueue(invalidSuffix);
      invalidController.close();
      await expect(invalidDownload).rejects.toThrow("integrity check failed");

      expect(contentsAfterValidPromotion).toEqual(Buffer.from(expected));
      await expect(readFile(destination)).resolves.toEqual(Buffer.from(expected));
      await expectNoTemporaryDownloads(destination);
    });
  });

  it("keeps a valid cached model and skips the network", async () => {
    await withTemporaryModel(async ({ destination }) => {
      const expected = new Uint8Array([9, 8, 7, 6]);
      await writeFile(destination, expected);
      const fetchImpl = vi.fn(async () => {
        throw new Error("network should not be used");
      });

      await expect(ensureModelAsset(boundedOptions(destination, expected, {
        fetchImpl
      }))).resolves.toBe("cached");

      expect(fetchImpl).not.toHaveBeenCalled();
      await expect(readFile(destination)).resolves.toEqual(Buffer.from(expected));
      await expectNoTemporaryDownloads(destination);
    });
  });
});
