import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearFileProviderHealthCacheForTest,
  __setFileProviderProbeRunnerForTest,
  FsPathUnresponsiveError,
} from "../infra/fs-fileprovider-health.js";

type CapturedReadOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | undefined>;
};

const mocks = vi.hoisted(() => ({
  operations: undefined as CapturedReadOperations | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    createReadTool: (_cwd: string, options?: { operations?: CapturedReadOperations }) => {
      mocks.operations = options?.operations;
      return {
        name: "read",
        description: "test read tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      };
    },
  };
});

const { createHostWorkspaceReadTool } = await import("./pi-tools.read.js");

describe("createHostWorkspaceReadTool File Provider probe wiring", () => {
  const MOBILE_DOCUMENTS = "/Users/demo/Library/Mobile Documents";
  const OBSIDIAN_PATH = `${MOBILE_DOCUMENTS}/iCloud~md~obsidian/Documents/Brain/note.md`;
  const originalPlatform = process.platform;
  let tmpDir = "";
  let localFile = "";

  beforeEach(() => {
    __clearFileProviderHealthCacheForTest();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(async () => {
    __setFileProviderProbeRunnerForTest(undefined);
    __clearFileProviderHealthCacheForTest();
    mocks.operations = undefined;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      tmpDir = "";
    }
  });

  it("passes an operations object with readFile/access/detectImageMimeType to createReadTool", () => {
    createHostWorkspaceReadTool("/Users/demo/workspace");
    expect(mocks.operations).toBeDefined();
    expect(typeof mocks.operations?.readFile).toBe("function");
    expect(typeof mocks.operations?.access).toBe("function");
    expect(typeof mocks.operations?.detectImageMimeType).toBe("function");
  });

  it("invokes the File Provider probe before fs.readFile on iCloud paths", async () => {
    const runner = vi.fn<(absPath: string, timeoutMs: number) => Promise<void>>(async () => {});
    __setFileProviderProbeRunnerForTest(runner);

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-read-probe-"));
    localFile = path.join(tmpDir, "file.txt");
    await fs.writeFile(localFile, "content");

    createHostWorkspaceReadTool(tmpDir);
    expect(mocks.operations).toBeDefined();

    // Local path: probe is skipped entirely (fast path).
    await mocks.operations!.readFile(localFile);
    expect(runner).not.toHaveBeenCalled();

    // iCloud path: probe must be called. We don't care that the read itself
    // fails (path doesn't exist in the test); we care that the probe fired.
    await mocks.operations!.readFile(OBSIDIAN_PATH).catch(() => {});
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toBe(OBSIDIAN_PATH);
  });

  it("surfaces FsPathUnresponsiveError when the probe times out, before fs.readFile runs", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
    });
    __setFileProviderProbeRunnerForTest(runner);

    createHostWorkspaceReadTool("/Users/demo/workspace");
    expect(mocks.operations).toBeDefined();

    await expect(mocks.operations!.readFile(OBSIDIAN_PATH)).rejects.toBeInstanceOf(
      FsPathUnresponsiveError,
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("runs the probe for access() too", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
    });
    __setFileProviderProbeRunnerForTest(runner);

    createHostWorkspaceReadTool("/Users/demo/workspace");
    expect(mocks.operations).toBeDefined();

    await expect(mocks.operations!.access(OBSIDIAN_PATH)).rejects.toBeInstanceOf(
      FsPathUnresponsiveError,
    );
  });

  it("runs the probe for detectImageMimeType() too", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
    });
    __setFileProviderProbeRunnerForTest(runner);

    createHostWorkspaceReadTool("/Users/demo/workspace");
    expect(mocks.operations).toBeDefined();

    await expect(mocks.operations!.detectImageMimeType!(OBSIDIAN_PATH)).rejects.toBeInstanceOf(
      FsPathUnresponsiveError,
    );
  });
});
