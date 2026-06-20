import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "mentat-malik-graph-wake",
    name: "Mentat Malik Graph Wake",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
  });
}

describe("mentat malik graph wake plugin registration", () => {
  it("does not register routes unless explicitly enabled", () => {
    const registerHttpRoute = vi.fn();
    plugin.register(createApi({ registerHttpRoute }));
    expect(registerHttpRoute).not.toHaveBeenCalled();
  });

  it("registers the sandbox graph wake route when enabled", () => {
    const registerHttpRoute = vi.fn();
    plugin.register(createApi({ pluginConfig: { enabled: true }, registerHttpRoute }));

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const [route] = registerHttpRoute.mock.calls[0] as Parameters<
      OpenClawPluginApi["registerHttpRoute"]
    >;
    expect(route.path).toBe("/plugins/mentat/malik-sandbox-graph-wake");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
  });
});
