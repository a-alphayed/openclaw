import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  createMalikSandboxGraphWakeHandler,
  createMalikSandboxGraphWakeState,
} from "./src/bridge.js";

const DEFAULT_ROUTE_PATH = "/plugins/mentat/malik-sandbox-graph-wake";

type PluginConfig = {
  enabled: boolean;
  path: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvePluginConfig(pluginConfig: OpenClawPluginApi["pluginConfig"]): PluginConfig {
  const input =
    pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
      ? (pluginConfig as Record<string, unknown>)
      : {};
  return {
    enabled: input.enabled === true,
    path: readString(input.path) ?? DEFAULT_ROUTE_PATH,
  };
}

export default definePluginEntry({
  id: "mentat-malik-graph-wake",
  name: "Mentat Malik Graph Wake",
  description: "Sandbox-only Microsoft Graph webhook wake bridge for Malik Mentat workflows.",
  register(api: OpenClawPluginApi) {
    const config = resolvePluginConfig(api.pluginConfig);
    if (!config.enabled) {
      return;
    }

    const handler = createMalikSandboxGraphWakeHandler({
      state: createMalikSandboxGraphWakeState(),
      loadActiveWindow: async () => null,
      fetchScopedSource: async () => ({ sourceRefs: [] }),
      postAgentWake: async () => ({
        accepted: false,
        status: "host_poster_unconfigured",
      }),
    });

    api.registerHttpRoute({
      path: config.path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler,
    });
    api.logger.info?.(
      `[mentat-malik-graph-wake] registered sandbox-only Graph wake route ${config.path}`,
    );
  },
});

export {
  createMalikSandboxGraphWakeHandler,
  createMalikSandboxGraphWakeState,
  handleMalikSandboxGraphWakeRequest,
} from "./src/bridge.js";
