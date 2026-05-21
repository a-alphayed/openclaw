import fs from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOpenClawPluginSdkAliasNodePath } from "./plugin-sdk-dist-alias.js";

const moduleWithInitPaths = Module as typeof Module & { _initPaths?: () => void };
const originalNodePath = process.env.NODE_PATH;

afterEach(() => {
  if (originalNodePath === undefined) {
    delete process.env.NODE_PATH;
  } else {
    process.env.NODE_PATH = originalNodePath;
  }
  moduleWithInitPaths._initPaths?.();
});

describe("ensureOpenClawPluginSdkAliasNodePath", () => {
  it("lets built external plugins resolve OpenClaw SDK subpaths with createRequire", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-alias-"));
    const distRoot = path.join(root, "dist");
    const pluginSdkDir = path.join(distRoot, "plugin-sdk");
    fs.mkdirSync(pluginSdkDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginSdkDir, "discord.js"),
      [
        'export const sendDiscordComponentMessage = () => "component";',
        'export const sendPollDiscord = () => "poll";',
        "",
      ].join("\n"),
      "utf8",
    );

    const externalPluginEntry = path.join(root, "external-plugin", "dist", "runtime-api.js");
    fs.mkdirSync(path.dirname(externalPluginEntry), { recursive: true });
    fs.writeFileSync(externalPluginEntry, "export default {};\n", "utf8");

    const aliasNodeModules = ensureOpenClawPluginSdkAliasNodePath({ distRoot });

    expect(aliasNodeModules).toBe(path.join(distRoot, "extensions", "node_modules"));
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/discord"))).toBe(
      fs.realpathSync(path.join(aliasNodeModules ?? "", "openclaw", "plugin-sdk", "discord.js")),
    );
    const sdk = requireFromPlugin("openclaw/plugin-sdk/discord") as {
      sendDiscordComponentMessage?: () => string;
      sendPollDiscord?: () => string;
    };

    expect(sdk.sendDiscordComponentMessage?.()).toBe("component");
    expect(sdk.sendPollDiscord?.()).toBe("poll");
  });
});
