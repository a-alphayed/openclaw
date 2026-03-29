import type { DymoLabelPluginConfig } from "./types.js";

export function resolveDymoLabelConfig(raw?: Record<string, unknown>): DymoLabelPluginConfig {
  const cfg = (raw ?? {}) as Partial<DymoLabelPluginConfig>;
  return {
    tailscaleHost: typeof cfg.tailscaleHost === "string" ? cfg.tailscaleHost : undefined,
    sshUser: typeof cfg.sshUser === "string" ? cfg.sshUser : undefined,
    printerName: typeof cfg.printerName === "string" ? cfg.printerName : undefined,
    defaultBinLocation:
      typeof cfg.defaultBinLocation === "string" ? cfg.defaultBinLocation : undefined,
  };
}
