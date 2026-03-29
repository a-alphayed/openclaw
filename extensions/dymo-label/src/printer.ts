import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginLogger } from "../api.js";

const execFileAsync = promisify(execFile);

type PrintOptions = {
  tailscaleHost: string;
  sshUser: string;
  printerName?: string;
  logger: PluginLogger;
};

type PrintResult = {
  printer: string;
  host: string;
  jobId: string;
};

/** Discover a Dymo printer on the remote host via lpstat. */
async function discoverDymoPrinter(host: string, user: string): Promise<string> {
  const { stdout } = await execFileAsync("ssh", [`${user}@${host}`, "lpstat", "-p"], {
    timeout: 10_000,
  });
  for (const line of stdout.split("\n")) {
    const match = line.match(/^printer\s+(\S+)/);
    if (match && /dymo|labelwriter/i.test(match[1])) {
      return match[1];
    }
  }
  throw new Error(
    `No Dymo printer found on ${host}. Set printerName in plugin config ` +
      "or ensure the LabelWriter is set up in System Settings > Printers & Scanners.",
  );
}

/**
 * Pre-flight gate: check printer is enabled and has no stuck jobs.
 * If disabled, attempt to re-enable. If queue is not empty, error out
 * so the agent doesn't pile up blind jobs.
 */
async function ensurePrinterReady(
  host: string,
  user: string,
  printer: string,
  logger: PluginLogger,
): Promise<void> {
  const sshTarget = `${user}@${host}`;

  // Check printer status
  const { stdout: statusOut } = await execFileAsync(
    "ssh",
    ["-o", "ConnectTimeout=10", sshTarget, "lpstat", "-p", printer],
    { timeout: 10_000 },
  );

  const isDisabled = /disabled/i.test(statusOut);
  const isNotReady = /not ready/i.test(statusOut);

  if (isDisabled) {
    logger.info(`Printer ${printer} is disabled — attempting to re-enable`);
    await execFileAsync("ssh", ["-o", "ConnectTimeout=10", sshTarget, "cupsenable", printer], {
      timeout: 10_000,
    });

    // Re-check after enable
    const { stdout: recheck } = await execFileAsync(
      "ssh",
      ["-o", "ConnectTimeout=10", sshTarget, "lpstat", "-p", printer],
      { timeout: 10_000 },
    );

    if (/disabled/i.test(recheck) || /not ready/i.test(recheck)) {
      throw new Error(
        `Printer ${printer} on ${host} is disabled and could not be re-enabled. ` +
          "Check the physical connection (USB) and try again.",
      );
    }
    logger.info(`Printer ${printer} re-enabled successfully`);
  } else if (isNotReady) {
    throw new Error(
      `Printer ${printer} on ${host} is not ready. Check the physical connection and try again.`,
    );
  }

  // Check for stuck jobs in the queue
  const { stdout: queueOut } = await execFileAsync(
    "ssh",
    ["-o", "ConnectTimeout=10", sshTarget, "lpstat", "-o", printer],
    { timeout: 10_000 },
  ).catch(() => ({ stdout: "" }));

  const queuedJobs = queueOut.split("\n").filter((l) => l.trim().length > 0);
  if (queuedJobs.length > 0) {
    throw new Error(
      `Printer ${printer} has ${queuedJobs.length} queued job(s). ` +
        "Clear the queue first (cancel -a DYMO_LabelWriter_550) before sending new jobs.",
    );
  }
}

/** Print a PDF buffer on the remote Dymo printer via SSH + lp. */
export async function printPdf(pdfBuffer: Buffer, options: PrintOptions): Promise<PrintResult> {
  const { tailscaleHost, sshUser, logger } = options;
  const printer = options.printerName ?? (await discoverDymoPrinter(tailscaleHost, sshUser));

  // Gate: printer must be enabled with an empty queue before we send anything
  await ensurePrinterReady(tailscaleHost, sshUser, printer, logger);

  logger.info(`Printing to ${printer} on ${tailscaleHost}`);

  const ts = Date.now();
  const remotePath = `/tmp/openclaw-dymo-${ts}.pdf`;
  const localPath = path.join(os.tmpdir(), `openclaw-dymo-${ts}.pdf`);

  try {
    // Write PDF locally
    await fs.writeFile(localPath, pdfBuffer);

    // SCP to remote host
    await execFileAsync(
      "scp",
      ["-o", "ConnectTimeout=10", localPath, `${sshUser}@${tailscaleHost}:${remotePath}`],
      { timeout: 15_000 },
    );

    // Print on remote host
    const { stdout: lpOut } = await execFileAsync(
      "ssh",
      [
        "-o",
        "ConnectTimeout=10",
        `${sshUser}@${tailscaleHost}`,
        "lp",
        "-d",
        printer,
        remotePath,
      ],
      { timeout: 15_000 },
    );

    // Extract job ID from lp output (e.g. "request id is DYMO_LabelWriter_550-331 (1 file(s))")
    const jobMatch = lpOut.match(/request id is (\S+)/);
    const jobId = jobMatch ? jobMatch[1] : "unknown";

    // Clean up remote temp file
    await execFileAsync("ssh", [`${sshUser}@${tailscaleHost}`, "rm", "-f", remotePath], {
      timeout: 10_000,
    }).catch(() => {
      // Non-critical — temp file will be cleaned by OS
    });

    return { printer, host: tailscaleHost, jobId };
  } finally {
    await fs.unlink(localPath).catch(() => {});
  }
}
