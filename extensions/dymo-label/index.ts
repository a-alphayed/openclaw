import { definePluginEntry, type AnyAgentTool, type OpenClawPluginApi } from "./api.js";
import { resolveDymoLabelConfig } from "./src/config.js";
import { createDymoLabelTool } from "./src/tool.js";

export default definePluginEntry({
  id: "dymo-label",
  name: "Dymo Label",
  description: "Print asset and parts labels on a Dymo LabelWriter 550 via Tailscale.",
  register(api: OpenClawPluginApi) {
    const config = resolveDymoLabelConfig(api.pluginConfig);
    api.registerTool(createDymoLabelTool({ api, config }) as unknown as AnyAgentTool);
  },
});
