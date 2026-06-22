import { readFileSync } from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

const MALIK_SANDBOX_MAILBOX = "malik-mentat@outlook.com";
const MALIK_GRAPH_RESOURCE_PREFIX = "users/malik-mentat@outlook.com/mailFolders/inbox/messages";
const NETSUITE_SANDBOX_ENVIRONMENT_ID = "netsuite-sandbox";
const ADAPTER_REQUIRED_ACTIVE_WINDOW_FIELDS = [
  "id",
  "approved",
  "expiresAt",
  "mailbox",
  "graphResourcePrefix",
  "runtimeProfile",
  "netSuiteTarget",
  "allowedActions",
  "sourceScope",
  "clientStateSha256",
];

type JsonRecord = Record<string, unknown>;

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

function readManifestConfigSchema(): JsonRecord {
  const manifest = readJsonRecord(new URL("./openclaw.plugin.json", import.meta.url));
  return requireRecord(manifest.configSchema, "configSchema");
}

function readJsonRecord(url: URL): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(url, "utf8")), url.pathname);
}

function propertiesOf(schema: JsonRecord): JsonRecord {
  return requireRecord(schema.properties, "schema.properties");
}

function requiredOf(schema: JsonRecord): string[] {
  return requireStringArray(schema.required, "schema.required");
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAgainstSchema(schema: JsonRecord, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if ("const" in schema && !Object.is(value, schema.const)) {
    errors.push(`${path} must equal configured const`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must match configured enum`);
    return errors;
  }

  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !matchesJsonType(value, type)) {
    errors.push(`${path} must be ${type}`);
    return errors;
  }

  if (type === "object") {
    validateObjectSchema(schema, value, path, errors);
  }
  if (type === "array") {
    validateArraySchema(schema, value, path, errors);
  }
  if (type === "string") {
    validateStringSchema(schema, value, path, errors);
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (
    anyOf &&
    !anyOf.some(
      (candidate) =>
        isRecord(candidate) && validateAgainstSchema(candidate, value, path).length === 0,
    )
  ) {
    errors.push(`${path} must match at least one anyOf schema`);
  }

  return errors;
}

function validateObjectSchema(
  schema: JsonRecord,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    return;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const required of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof required === "string" && !(required in value)) {
      errors.push(`${path}.${required} is required`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
  const dependentRequired = isRecord(schema.dependentRequired) ? schema.dependentRequired : {};
  for (const [key, dependencies] of Object.entries(dependentRequired)) {
    if (!(key in value)) {
      continue;
    }
    for (const dependency of requireStringArray(dependencies, `${path}.${key}.dependentRequired`)) {
      if (!(dependency in value)) {
        errors.push(`${path}.${dependency} is required with ${key}`);
      }
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in value && isRecord(propertySchema)) {
      errors.push(...validateAgainstSchema(propertySchema, value[key], `${path}.${key}`));
    }
  }
}

function validateArraySchema(
  schema: JsonRecord,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    return;
  }
  const minItems = typeof schema.minItems === "number" ? schema.minItems : undefined;
  const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
  if (minItems !== undefined && value.length < minItems) {
    errors.push(`${path} must have at least ${minItems} items`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    errors.push(`${path} must have at most ${maxItems} items`);
  }
  if (isRecord(schema.items)) {
    value.forEach((entry, index) => {
      errors.push(...validateAgainstSchema(schema.items as JsonRecord, entry, `${path}[${index}]`));
    });
  }
}

function validateStringSchema(
  schema: JsonRecord,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value !== "string") {
    return;
  }
  const minLength = typeof schema.minLength === "number" ? schema.minLength : undefined;
  if (minLength !== undefined && value.length < minLength) {
    errors.push(`${path} must have length >= ${minLength}`);
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} must match pattern`);
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "object") {
    return isRecord(value);
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  return typeof value === type;
}

function approvedWindowFixture(): JsonRecord {
  return {
    enabled: true,
    activeWindow: {
      id: "malik-sandbox-host-proof-2026-06-21-0930",
      approved: true,
      expiresAt: "2026-06-21T10:30:00-07:00",
      mailbox: MALIK_SANDBOX_MAILBOX,
      graphResourcePrefix: MALIK_GRAPH_RESOURCE_PREFIX,
      runtimeProfile: {
        environmentClass: "sandbox",
        environmentId: NETSUITE_SANDBOX_ENVIRONMENT_ID,
      },
      netSuiteTarget: {
        environmentClass: "sandbox",
        environmentId: NETSUITE_SANDBOX_ENVIRONMENT_ID,
      },
      allowedActions: [{ family: "purchase_orders", action: "create_po" }],
      sourceScope: {
        selector: "subject:Malik sandbox host proof 2026-06-21 0930 PDT",
        receivedAfter: "2026-06-21T09:30:00-07:00",
        receivedBefore: "2026-06-21T10:30:00-07:00",
      },
      clientStateSha256: "a".repeat(64),
    },
    graph: {
      bearerTokenRef: {
        source: "env",
        provider: "default",
        id: "MENTAT_MALIK_GRAPH_TOKEN",
      },
    },
  };
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

describe("mentat malik graph wake manifest config schema", () => {
  it("keeps disabled default config valid while exposing host adapter fields", () => {
    const schema = readManifestConfigSchema();
    const properties = propertiesOf(schema);

    expect(validateAgainstSchema(schema, {})).toEqual([]);
    expect(validateAgainstSchema(schema, { enabled: false })).toEqual([]);
    expect(properties.activeWindow).toBeDefined();
    expect(properties.graph).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("requires every adapter-consumed activeWindow field", () => {
    const activeWindow = requireRecord(
      propertiesOf(readManifestConfigSchema()).activeWindow,
      "activeWindow",
    );

    expect(requiredOf(activeWindow)).toEqual(ADAPTER_REQUIRED_ACTIVE_WINDOW_FIELDS);
    expect(activeWindow.additionalProperties).toBe(false);
  });

  it("constrains activeWindow to the approved sandbox target", () => {
    const activeWindowProperties = propertiesOf(
      requireRecord(propertiesOf(readManifestConfigSchema()).activeWindow, "activeWindow"),
    );
    const activeWindowId = requireRecord(activeWindowProperties.id, "activeWindow.id");
    const runtimeProfileProperties = propertiesOf(
      requireRecord(activeWindowProperties.runtimeProfile, "runtimeProfile"),
    );
    const netSuiteTargetProperties = propertiesOf(
      requireRecord(activeWindowProperties.netSuiteTarget, "netSuiteTarget"),
    );

    expect(activeWindowId.pattern).toBe("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
    expect(validateAgainstSchema(activeWindowId, "sandbox-window-2026-06-20")).toEqual([]);
    expect(validateAgainstSchema(activeWindowId, "sandbox-window:unsafe")).toContain(
      "$ must match pattern",
    );
    expect(requireRecord(activeWindowProperties.approved, "approved").const).toBe(true);
    expect(requireRecord(activeWindowProperties.mailbox, "mailbox").const).toBe(
      MALIK_SANDBOX_MAILBOX,
    );
    expect(
      requireRecord(activeWindowProperties.graphResourcePrefix, "graphResourcePrefix").const,
    ).toBe(MALIK_GRAPH_RESOURCE_PREFIX);
    expect(
      requireRecord(runtimeProfileProperties.environmentClass, "runtimeProfile.environmentClass")
        .const,
    ).toBe("sandbox");
    expect(
      requireRecord(runtimeProfileProperties.environmentId, "runtimeProfile.environmentId").const,
    ).toBe(NETSUITE_SANDBOX_ENVIRONMENT_ID);
    expect(
      requireRecord(netSuiteTargetProperties.environmentClass, "netSuiteTarget.environmentClass")
        .const,
    ).toBe("sandbox");
    expect(
      requireRecord(netSuiteTargetProperties.environmentId, "netSuiteTarget.environmentId").const,
    ).toBe(NETSUITE_SANDBOX_ENVIRONMENT_ID);
  });

  it("constrains allowedActions to exactly purchase_orders.create_po", () => {
    const activeWindowProperties = propertiesOf(
      requireRecord(propertiesOf(readManifestConfigSchema()).activeWindow, "activeWindow"),
    );
    const allowedActions = requireRecord(activeWindowProperties.allowedActions, "allowedActions");
    const actionProperties = propertiesOf(
      requireRecord(allowedActions.items, "allowedActions.items"),
    );

    expect(allowedActions.minItems).toBe(1);
    expect(allowedActions.maxItems).toBe(1);
    expect(requireRecord(actionProperties.family, "family").const).toBe("purchase_orders");
    expect(requireRecord(actionProperties.action, "action").const).toBe("create_po");
    expect(
      validateAgainstSchema(allowedActions, [
        { family: "purchase_orders", action: "vendor_notification" },
      ]),
    ).toContain("$[0].action must equal configured const");
  });

  it("requires a 64-hex clientStateSha256 digest", () => {
    const activeWindowProperties = propertiesOf(
      requireRecord(propertiesOf(readManifestConfigSchema()).activeWindow, "activeWindow"),
    );
    const clientStateSha256 = requireRecord(
      activeWindowProperties.clientStateSha256,
      "clientStateSha256",
    );

    expect(clientStateSha256.pattern).toBe("^[a-fA-F0-9]{64}$");
    expect(validateAgainstSchema(clientStateSha256, "a".repeat(64))).toEqual([]);
    expect(validateAgainstSchema(clientStateSha256, "not-a-digest")).toContain(
      "$ must match pattern",
    );
  });

  it("requires graph bearerTokenRef to be a SecretRef without raw token fields", () => {
    const graph = requireRecord(propertiesOf(readManifestConfigSchema()).graph, "graph");
    const bearerTokenRef = requireRecord(propertiesOf(graph).bearerTokenRef, "bearerTokenRef");
    const bearerTokenRefProperties = propertiesOf(bearerTokenRef);

    expect(graph.additionalProperties).toBe(false);
    expect(requiredOf(graph)).toEqual(["bearerTokenRef"]);
    expect(bearerTokenRef.additionalProperties).toBe(false);
    expect(requiredOf(bearerTokenRef)).toEqual(["source", "provider", "id"]);
    expect(requireRecord(bearerTokenRefProperties.source, "source").enum).toEqual([
      "env",
      "file",
      "exec",
    ]);
    expect(Object.keys(bearerTokenRefProperties).sort()).toEqual(["id", "provider", "source"]);
    expect(bearerTokenRefProperties).not.toHaveProperty("value");
    expect(bearerTokenRefProperties).not.toHaveProperty("token");
    expect(bearerTokenRefProperties).not.toHaveProperty("password");
  });

  it("validates the approved host-proof window fixture with only a SecretRef token reference", () => {
    const schema = readManifestConfigSchema();

    expect(validateAgainstSchema(schema, approvedWindowFixture())).toEqual([]);
    expect(
      validateAgainstSchema(schema, {
        ...approvedWindowFixture(),
        graph: {
          bearerTokenRef: {
            source: "env",
            provider: "default",
            id: "MENTAT_MALIK_GRAPH_TOKEN",
            token: "raw-token-is-not-allowed",
          },
        },
      }),
    ).toContain("$.graph.bearerTokenRef.token is not allowed");
  });
});
