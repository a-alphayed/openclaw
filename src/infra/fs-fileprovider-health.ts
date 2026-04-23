import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { logWarn } from "../logger.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_CACHE_MS = 10_000;

// macOS File Provider root. Every provider container lives directly underneath
// (e.g. .../Mobile Documents/iCloud~md~obsidian, .../Mobile Documents/com~apple~CloudDocs).
// A wedged fileproviderd/bird pins libuv workers on any syscall against these
// paths, which is not recoverable via AbortSignal — fs.promises.open on macOS
// libuv uses openat$NOCANCEL, which ignores signal cancellation. The gate in
// this module is a separate child process running /usr/bin/stat, which uses
// the cancellable openat variant and can be SIGKILL'd on timeout without
// touching the gateway's libuv pool.
const FILE_PROVIDER_ROOT_SEGMENT = `${path.sep}Library${path.sep}Mobile Documents${path.sep}`;

export class FsPathUnresponsiveError extends Error {
  readonly containerKey: string;

  constructor(containerKey: string, filePath: string, options?: ErrorOptions) {
    super(
      `file provider path unresponsive (container=${containerKey}): ${filePath}. ` +
        `The macOS File Provider daemon (fileproviderd/bird) may be wedged — ` +
        `the path did not respond within the probe timeout. Try ` +
        `\`killall fileproviderd bird\` to force a recovery.`,
      options,
    );
    this.name = "FsPathUnresponsiveError";
    this.containerKey = containerKey;
  }
}

type HealthEntry = {
  healthy: boolean;
  expiresAt: number;
};

const healthCache = new Map<string, HealthEntry>();

type ProbeRunner = (absPath: string, timeoutMs: number) => Promise<void>;

let probeRunnerOverride: ProbeRunner | undefined;

function allowTestHooks(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

export function __setFileProviderProbeRunnerForTest(runner?: ProbeRunner): void {
  if (runner && !allowTestHooks()) {
    throw new Error("__setFileProviderProbeRunnerForTest is only available in tests");
  }
  probeRunnerOverride = runner;
}

export function __clearFileProviderHealthCacheForTest(): void {
  if (!allowTestHooks()) {
    throw new Error("__clearFileProviderHealthCacheForTest is only available in tests");
  }
  healthCache.clear();
}

export function isFileProviderPath(absPath: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  return absPath.includes(FILE_PROVIDER_ROOT_SEGMENT);
}

function extractContainerKey(absPath: string): string {
  const idx = absPath.indexOf(FILE_PROVIDER_ROOT_SEGMENT);
  if (idx < 0) {
    return absPath;
  }
  const tail = absPath.slice(idx + FILE_PROVIDER_ROOT_SEGMENT.length);
  const sepIdx = tail.indexOf(path.sep);
  const container = sepIdx < 0 ? tail : tail.slice(0, sepIdx);
  return container.length > 0 ? container : "mobile-documents-root";
}

async function runStatProbe(absPath: string, timeoutMs: number): Promise<void> {
  // execFile's timeout fires SIGKILL when exceeded. /usr/bin/stat uses the
  // cancellable openat (not $NOCANCEL), so the kernel honors the signal and
  // the child is reliably reaped — no libuv worker touched by our probe.
  await execFileAsync("/usr/bin/stat", [absPath], {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function assertFileProviderResponsive(filePath: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!isFileProviderPath(absPath)) {
    return;
  }

  const containerKey = extractContainerKey(absPath);
  const now = Date.now();
  const cached = healthCache.get(containerKey);
  if (cached && cached.expiresAt > now) {
    if (cached.healthy) {
      return;
    }
    throw new FsPathUnresponsiveError(containerKey, absPath);
  }

  const timeoutMs = readIntEnv("OPENCLAW_FILEPROVIDER_PROBE_MS", DEFAULT_PROBE_TIMEOUT_MS);
  const cacheMs = readIntEnv("OPENCLAW_FILEPROVIDER_CACHE_MS", DEFAULT_HEALTH_CACHE_MS);
  const runner = probeRunnerOverride ?? runStatProbe;

  try {
    await runner(absPath, timeoutMs);
    healthCache.set(containerKey, { healthy: true, expiresAt: Date.now() + cacheMs });
    return;
  } catch (err) {
    if (isProbeTimeout(err)) {
      const flippedFromHealthy = cached?.healthy !== false;
      healthCache.set(containerKey, { healthy: false, expiresAt: Date.now() + cacheMs });
      if (flippedFromHealthy) {
        logWarn(
          `fs-fileprovider: container "${containerKey}" marked unresponsive (probe timed out after ${timeoutMs}ms). fileproviderd/bird may be wedged.`,
        );
      }
      throw new FsPathUnresponsiveError(containerKey, absPath, { cause: asError(err) });
    }
    if (isStatFastFailure(err)) {
      // /usr/bin/stat ran and exited non-zero (ENOENT/EACCES/EPERM on the
      // target). The provider was responsive enough to answer; fall through
      // so the real fs layer surfaces the proper ENOENT/EACCES/etc.
      healthCache.set(containerKey, { healthy: true, expiresAt: Date.now() + cacheMs });
      return;
    }
    // Ambiguous probe failure (spawn error, EIO, unknown code). Do not cache
    // either way — let the real fs call surface whatever error would occur.
    // If iCloud is actually wedged, the next caller re-probes and will hit
    // the SIGKILL timeout path above.
  }
}

function isProbeTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const maybe = err as { killed?: boolean; signal?: string; code?: string | number };
  if (maybe.killed === true && maybe.signal === "SIGKILL") {
    return true;
  }
  if (maybe.code === "ETIMEDOUT") {
    return true;
  }
  return false;
}

function isStatFastFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const maybe = err as { killed?: boolean; signal?: string; code?: string | number };
  if (maybe.killed === true) {
    return false;
  }
  // Numeric exit code from /usr/bin/stat — it ran to completion and reported a
  // path-level error (ENOENT, EACCES, EPERM). Provider is responsive.
  return typeof maybe.code === "number" && maybe.code === 1;
}

function asError(err: unknown): Error | undefined {
  return err instanceof Error ? err : undefined;
}
