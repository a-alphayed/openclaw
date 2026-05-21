import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { writeJsonSync } from "../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

type ModuleWithInitPaths = typeof Module & { _initPaths?: () => void };

function writeRuntimeJsonFile(targetPath: string, value: unknown): void {
  writeJsonSync(targetPath, value);
}

function writeRuntimeModuleWrapper(sourcePath: string, targetPath: string): void {
  const relative = `./${path.relative(path.dirname(targetPath), sourcePath).split(path.sep).join("/")}`;
  const content = [`export * from ${JSON.stringify(relative)};`, ""].join("\n");
  try {
    if (fs.readFileSync(targetPath, "utf8") === content) {
      return;
    }
  } catch {
    // Missing or unreadable wrapper; rewrite below.
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

export function ensureOpenClawPluginSdkAlias(distRoot: string): void {
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
  writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk/index.js",
      "./plugin-sdk/*": "./plugin-sdk/*.js",
    },
  });
  try {
    if (fs.existsSync(pluginSdkAliasDir) && !fs.lstatSync(pluginSdkAliasDir).isDirectory()) {
      fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
    }
  } catch {
    // Another process may be creating the alias at the same time.
  }
  fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
  for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, entry.name),
      path.join(pluginSdkAliasDir, entry.name),
    );
  }
}

export type EnsureOpenClawPluginSdkAliasNodePathOptions = {
  distRoot?: string;
  packageRoot?: string | null;
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
};

export function ensureOpenClawPluginSdkAliasNodePath(
  options: EnsureOpenClawPluginSdkAliasNodePathOptions = {},
): string | null {
  const aliasNodeModules = resolveOpenClawPluginSdkAliasNodeModules(options);
  if (!aliasNodeModules) {
    return null;
  }
  addNodePath(aliasNodeModules);
  return aliasNodeModules;
}

export function resolveOpenClawPluginSdkAliasNodeModules(
  options: EnsureOpenClawPluginSdkAliasNodePathOptions = {},
): string | null {
  const distRoot = resolveOpenClawPluginSdkDistRoot(options);
  if (!distRoot) {
    return null;
  }
  ensureOpenClawPluginSdkAlias(distRoot);
  const aliasNodeModules = path.join(distRoot, "extensions", "node_modules");
  return fs.existsSync(path.join(aliasNodeModules, "openclaw", "package.json"))
    ? aliasNodeModules
    : null;
}

function resolveOpenClawPluginSdkDistRoot(
  options: EnsureOpenClawPluginSdkAliasNodePathOptions,
): string | null {
  if (options.distRoot) {
    return path.resolve(options.distRoot);
  }
  const packageRoot =
    options.packageRoot ??
    resolveOpenClawPackageRootSync({
      cwd: options.cwd ?? process.cwd(),
      argv1: options.argv1 ?? process.argv[1],
      moduleUrl: options.moduleUrl,
    });
  if (!packageRoot) {
    return null;
  }
  return path.basename(packageRoot) === "dist" ? packageRoot : path.join(packageRoot, "dist");
}

function addNodePath(nodeModulesPath: string): void {
  const normalized = path.resolve(nodeModulesPath);
  const existing = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);
  if (!existing.some((entry) => path.resolve(entry) === normalized)) {
    process.env.NODE_PATH = [normalized, ...existing].join(path.delimiter);
  }
  const initPaths = (Module as ModuleWithInitPaths)._initPaths;
  initPaths?.();
}
