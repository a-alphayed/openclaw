import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearFileProviderHealthCacheForTest,
  __setFileProviderProbeRunnerForTest,
  assertFileProviderResponsive,
  FsPathUnresponsiveError,
  isFileProviderPath,
} from "./fs-fileprovider-health.js";

const MOBILE_DOCUMENTS = "/Users/demo/Library/Mobile Documents";
const OBSIDIAN_PATH = `${MOBILE_DOCUMENTS}/iCloud~md~obsidian/Documents/Brain/note.md`;
const LOCAL_PATH = "/Users/demo/projects/repo/README.md";

describe("fs-fileprovider-health", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    __clearFileProviderHealthCacheForTest();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    __setFileProviderProbeRunnerForTest(undefined);
    __clearFileProviderHealthCacheForTest();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  describe("isFileProviderPath", () => {
    it("matches Mobile Documents paths on darwin", () => {
      expect(isFileProviderPath(OBSIDIAN_PATH)).toBe(true);
      expect(isFileProviderPath(`${MOBILE_DOCUMENTS}/com~apple~CloudDocs/foo`)).toBe(true);
    });

    it("does not match local paths", () => {
      expect(isFileProviderPath(LOCAL_PATH)).toBe(false);
      expect(isFileProviderPath("/Users/demo/Documents/Wiki/page.md")).toBe(false);
    });

    it("returns false off-darwin regardless of path shape", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(isFileProviderPath(OBSIDIAN_PATH)).toBe(false);
    });
  });

  describe("assertFileProviderResponsive", () => {
    it("is a no-op for local paths and never invokes the probe", async () => {
      const runner = vi.fn(async () => {});
      __setFileProviderProbeRunnerForTest(runner);

      await expect(assertFileProviderResponsive(LOCAL_PATH)).resolves.toBeUndefined();
      expect(runner).not.toHaveBeenCalled();
    });

    it("is a no-op off-darwin even for Mobile Documents paths", async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const runner = vi.fn(async () => {});
      __setFileProviderProbeRunnerForTest(runner);

      await expect(assertFileProviderResponsive(OBSIDIAN_PATH)).resolves.toBeUndefined();
      expect(runner).not.toHaveBeenCalled();
    });

    it("probes once and caches healthy result for subsequent calls", async () => {
      const runner = vi.fn(async () => {});
      __setFileProviderProbeRunnerForTest(runner);

      await assertFileProviderResponsive(OBSIDIAN_PATH);
      await assertFileProviderResponsive(OBSIDIAN_PATH);
      await assertFileProviderResponsive(
        `${MOBILE_DOCUMENTS}/iCloud~md~obsidian/Documents/other.md`,
      );

      expect(runner).toHaveBeenCalledTimes(1);
    });

    it("re-probes for a different container key", async () => {
      const runner = vi.fn(async () => {});
      __setFileProviderProbeRunnerForTest(runner);

      await assertFileProviderResponsive(OBSIDIAN_PATH);
      await assertFileProviderResponsive(`${MOBILE_DOCUMENTS}/com~apple~CloudDocs/foo.md`);

      expect(runner).toHaveBeenCalledTimes(2);
    });

    it("throws FsPathUnresponsiveError on probe timeout and caches unhealthy", async () => {
      const runner = vi.fn(async () => {
        throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
      });
      __setFileProviderProbeRunnerForTest(runner);

      await expect(assertFileProviderResponsive(OBSIDIAN_PATH)).rejects.toBeInstanceOf(
        FsPathUnresponsiveError,
      );

      // Cache hit: second call does not re-probe and throws from cache.
      await expect(assertFileProviderResponsive(OBSIDIAN_PATH)).rejects.toBeInstanceOf(
        FsPathUnresponsiveError,
      );
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it("treats a fast non-zero stat exit (code 1) as healthy and falls through", async () => {
      // /usr/bin/stat exits 1 for ENOENT/EACCES/EPERM — provider is responsive;
      // the real fs layer should surface the proper error.
      const runner = vi.fn(async () => {
        throw Object.assign(new Error("stat: No such file or directory"), { code: 1 });
      });
      __setFileProviderProbeRunnerForTest(runner);

      await expect(assertFileProviderResponsive(OBSIDIAN_PATH)).resolves.toBeUndefined();
      // Cached healthy — subsequent calls skip the probe.
      await assertFileProviderResponsive(OBSIDIAN_PATH);
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it("respects ETIMEDOUT as a timeout signal too", async () => {
      const runner = vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      });
      __setFileProviderProbeRunnerForTest(runner);

      await expect(assertFileProviderResponsive(OBSIDIAN_PATH)).rejects.toBeInstanceOf(
        FsPathUnresponsiveError,
      );
    });

    it("does not cache healthy on ambiguous probe failures (spawn error, EIO)", async () => {
      // Spawn failure (stat binary missing) or EIO from the provider itself:
      // we can't tell whether iCloud is healthy, so don't cache either way.
      // Next caller should re-probe.
      const runner = vi.fn(async () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      });
      __setFileProviderProbeRunnerForTest(runner);

      await expect(assertFileProviderResponsive(OBSIDIAN_PATH)).resolves.toBeUndefined();
      await assertFileProviderResponsive(OBSIDIAN_PATH);
      // Re-probed because the first call didn't cache the result.
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it("does not cache healthy on unknown numeric exit codes (e.g. EIO=5)", async () => {
      const runner = vi.fn(async () => {
        throw Object.assign(new Error("i/o error"), { code: 5 });
      });
      __setFileProviderProbeRunnerForTest(runner);

      await assertFileProviderResponsive(OBSIDIAN_PATH);
      await assertFileProviderResponsive(OBSIDIAN_PATH);
      expect(runner).toHaveBeenCalledTimes(2);
    });
  });
});
