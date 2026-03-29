// Narrow plugin-sdk surface for the bundled dymo-label plugin.
// Keep this list additive and scoped to symbols used under extensions/dymo-label.

export { definePluginEntry } from "./plugin-entry.js";
export type { AnyAgentTool, OpenClawPluginApi, PluginLogger } from "../plugins/types.js";
