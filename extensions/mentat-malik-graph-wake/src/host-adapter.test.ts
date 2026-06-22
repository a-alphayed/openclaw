import { createHash } from "node:crypto";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  MALIK_SANDBOX_MAILBOX,
  createMalikSandboxGraphWakeState,
  handleMalikSandboxGraphWakeRequest,
  type MalikSandboxGraphWakeDependencies,
} from "./bridge.js";
import {
  createMalikSandboxGraphWakeHostDependencies,
  type MalikSandboxGraphFetch,
} from "./host-adapter.js";

const EXPECTED_CLIENT_STATE = "expected-client-state";
const FAKE_GRAPH_TOKEN = "fake-graph-token";
const GRAPH_RESOURCE = "users/malik-mentat@outlook.com/mailFolders/inbox/messages/AAMk-redacted";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function activeWindowConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "sandbox-window-2026-06-20",
    approved: true,
    expiresAt: "2099-01-01T00:00:00.000Z",
    mailbox: MALIK_SANDBOX_MAILBOX,
    graphResourcePrefix: "users/malik-mentat@outlook.com/mailFolders/inbox/messages",
    runtimeProfile: {
      environmentClass: "sandbox",
      environmentId: "netsuite-sandbox",
    },
    netSuiteTarget: {
      environmentClass: "sandbox",
      environmentId: "netsuite-sandbox",
    },
    allowedActions: [{ family: "purchase_orders", action: "create_po" }],
    sourceScope: {
      selector: "subject:Malik sandbox E2E",
      receivedAfter: "2026-06-20T17:00:00.000Z",
      receivedBefore: "2026-06-20T18:00:00.000Z",
    },
    clientStateSha256: sha256Hex(EXPECTED_CLIENT_STATE),
    ...overrides,
  };
}

function pluginConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: true,
    activeWindow: activeWindowConfig(),
    graph: {
      bearerTokenRef: {
        source: "env",
        provider: "default",
        id: "MENTAT_MALIK_GRAPH_TOKEN",
      },
    },
    ...overrides,
  };
}

function graphNotification(clientState = EXPECTED_CLIENT_STATE, resource = GRAPH_RESOURCE) {
  return {
    value: [
      {
        subscriptionId: "subscription-redacted",
        clientState,
        changeType: "created",
        resource,
      },
    ],
  };
}

function graphMessage(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "AAMk-redacted",
    subject: "Malik sandbox E2E PO create",
    receivedDateTime: "2026-06-20T17:30:00.000Z",
    internetMessageId: "<message-redacted@example.invalid>",
    ...overrides,
  };
}

function createHarness(params?: {
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  graphResponse?: Record<string, unknown>;
  graphOk?: boolean;
  subagentRun?: ReturnType<typeof vi.fn>;
}): {
  deps: MalikSandboxGraphWakeDependencies;
  fetchGraph: ReturnType<typeof vi.fn>;
  subagentRun: ReturnType<typeof vi.fn>;
} {
  const subagentRun = params?.subagentRun ?? vi.fn(async () => ({ runId: "run-redacted" }));
  const fetchGraph = vi.fn(async () => ({
    ok: params?.graphOk ?? true,
    status: params?.graphOk === false ? 404 : 200,
    json: async () => params?.graphResponse ?? graphMessage(),
  })) satisfies MalikSandboxGraphFetch;
  const api = createTestPluginApi({
    pluginConfig: params?.config ?? pluginConfig(),
    config: {} as OpenClawPluginApi["config"],
    runtime: {
      subagent: {
        run: subagentRun,
      },
    } as unknown as OpenClawPluginApi["runtime"],
  });
  const deps = createMalikSandboxGraphWakeHostDependencies({
    api,
    env: params?.env ?? { MENTAT_MALIK_GRAPH_TOKEN: FAKE_GRAPH_TOKEN },
    fetchGraph,
    now: () => new Date("2026-06-20T17:30:00.000Z"),
    state: createMalikSandboxGraphWakeState(),
  });
  return { deps, fetchGraph, subagentRun };
}

async function postNotification(
  deps: MalikSandboxGraphWakeDependencies,
  body = graphNotification(),
) {
  return await handleMalikSandboxGraphWakeRequest(
    {
      method: "POST",
      url: "/plugins/mentat/malik-sandbox-graph-wake",
      body: JSON.stringify(body),
    },
    deps,
  );
}

describe("Malik sandbox Graph wake host adapter", () => {
  it("fails closed when host adapter config is missing without Graph fetch or wake", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({ config: { enabled: true } });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_window_unavailable",
    });
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("fails closed when Graph token SecretRef config is missing without Graph fetch or wake", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({
      config: pluginConfig({ graph: {} }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "host_graph_source_unconfigured",
    });
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("verifies clientState by digest without echoing mismatched values", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness();

    const response = await postNotification(deps, graphNotification("wrong-client-state"));

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "client_state_mismatch",
    });
    expect(JSON.stringify(response.body)).not.toContain("wrong-client-state");
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("does not fetch Graph before active-window and source-scope gates pass", async () => {
    const cases = [
      {
        activeWindow: activeWindowConfig({ approved: false }),
        reason: "sandbox_window_unavailable",
      },
      {
        activeWindow: activeWindowConfig({ id: "sandbox-window:unsafe" }),
        reason: "sandbox_window_unavailable",
      },
      {
        activeWindow: activeWindowConfig({
          sourceScope: { receivedAfter: "2026-06-20T17:00:00.000Z" },
        }),
        reason: "sandbox_window_unavailable",
      },
      {
        activeWindow: activeWindowConfig({
          sourceScope: {
            receivedAfter: "2026-06-20T18:00:00.000Z",
            receivedBefore: "2026-06-20T18:00:00.000Z",
          },
        }),
        reason: "sandbox_window_unavailable",
      },
    ];

    for (const testCase of cases) {
      const { deps, fetchGraph, subagentRun } = createHarness({
        config: pluginConfig({ activeWindow: testCase.activeWindow }),
      });

      const response = await postNotification(deps);

      expect(response.body).toMatchObject({
        ok: false,
        status: "blocked",
        reason: testCase.reason,
      });
      expect(fetchGraph).not.toHaveBeenCalled();
      expect(subagentRun).not.toHaveBeenCalled();
    }
  });

  it("still accepts the old no-live fixture path and fetches through the approved mailbox", async () => {
    const { deps, fetchGraph } = createHarness();

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({ ok: true, status: "wake_posted" });
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    expect(fetchGraph).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/users/malik-mentat%40outlook.com/messages/AAMk-redacted?$select=id,subject,receivedDateTime,internetMessageId",
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${FAKE_GRAPH_TOKEN}`,
          accept: "application/json",
        },
      },
    );
  });

  it("fetches canonical notification message ids through the approved mailbox", async () => {
    const { deps, fetchGraph } = createHarness();
    const divergentUserSegment = "divergent-user@opaque-tenant";

    const response = await postNotification(
      deps,
      graphNotification(
        EXPECTED_CLIENT_STATE,
        `users/${divergentUserSegment}/messages/AAMk-redacted`,
      ),
    );

    expect(response.body).toMatchObject({ ok: true, status: "wake_posted" });
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    const [url] = fetchGraph.mock.calls[0];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/users/malik-mentat%40outlook.com/messages/AAMk-redacted?$select=id,subject,receivedDateTime,internetMessageId",
    );
    expect(url).not.toContain(divergentUserSegment);
  });

  it("URL-encodes opaque notification message ids in the Graph GET URL", async () => {
    const { deps, fetchGraph } = createHarness({
      graphResponse: graphMessage({ id: "AAMk/opaque+id" }),
    });

    const response = await postNotification(
      deps,
      graphNotification(EXPECTED_CLIENT_STATE, "Users/opaque-user/Messages/AAMk%2Fopaque+id"),
    );

    expect(response.body).toMatchObject({ ok: true, status: "wake_posted" });
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    const [url] = fetchGraph.mock.calls[0];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/users/malik-mentat%40outlook.com/messages/AAMk%2Fopaque%2Bid?$select=id,subject,receivedDateTime,internetMessageId",
    );
  });

  it("rejects malformed notification resources before Graph fetch", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness();

    const response = await postNotification(
      deps,
      graphNotification(
        EXPECTED_CLIENT_STATE,
        "users/malik-mentat@outlook.com/mailFolders/archive/messages/AAMk-redacted",
      ),
    );

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "notification_resource_not_approved",
    });
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("blocks Graph source results outside the approved selector before wake", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({
      graphResponse: graphMessage({ subject: "Different subject" }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "source_outside_approved_scope",
    });
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("blocks Graph source results outside the approved time window before wake", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({
      graphResponse: graphMessage({ receivedDateTime: "2026-06-20T18:30:00.000Z" }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "source_outside_approved_scope",
    });
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("blocks when the Graph source message cannot be fetched", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({ graphOk: false });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "host_graph_source_unavailable",
      hostStatus: "graph_fetch_failed",
    });
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("blocks when the runtime subagent poster rejects the wake", async () => {
    const subagentRun = vi.fn(async () => {
      throw new Error("runtime rejected with raw detail");
    });
    const { deps, subagentRun: runMock } = createHarness({ subagentRun });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "host_poster_rejected",
      hostStatus: "runtime_subagent_rejected",
    });
    expect(JSON.stringify(response.body)).not.toContain("raw detail");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("posts the wake through runtime subagent with deliver false and idempotency", async () => {
    const { deps, subagentRun } = createHarness();

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({ ok: true, status: "wake_posted" });
    expect(subagentRun).toHaveBeenCalledTimes(1);
    const [runParams] = subagentRun.mock.calls[0];
    expect(runParams).toMatchObject({
      sessionKey: "agent:malik:subagent:mentat-sandbox-sandbox-window-2026-06-20",
      deliver: false,
      lane: "subagent",
      lightContext: true,
    });
    expect(runParams.idempotencyKey).toMatch(/^malik-sandbox-graph-wake:/);
    expect(runParams.extraSystemPrompt).toContain("Malik Mentat sandbox Graph wake lane");
    expect(runParams.extraSystemPrompt).toContain("Do not use old Malik email, Fleet, NetSuite");
    expect(runParams.extraSystemPrompt).toContain("Do not send vendor/customer email");
    expect(runParams.extraSystemPrompt).toContain("Graph notifications as wake signals only");
    expect(runParams.message).toContain("Mentat Malik sandbox Graph webhook wake");
    expect(runParams.message).toContain("purchase_orders.create_po");
    expect(runParams.message).toContain('"graphNotificationAuthority":"wake_only"');
    expect(runParams.message).toContain('"emailSend":false');
    expect(runParams.message).toContain('"netSuiteMutation":false');
    expect(runParams.message).toContain("blocked_without_approved_sandbox_safe_recipient_plan");
    expect(runParams.message).not.toContain(FAKE_GRAPH_TOKEN);
    expect(runParams.message).not.toContain(EXPECTED_CLIENT_STATE);
    expect(runParams.message).not.toContain("AAMk-redacted");
    expect(runParams.message).not.toContain("Malik sandbox E2E");
    expect(runParams.extraSystemPrompt).not.toContain(FAKE_GRAPH_TOKEN);
    expect(runParams.extraSystemPrompt).not.toContain(EXPECTED_CLIENT_STATE);
    expect(runParams.extraSystemPrompt).not.toContain("AAMk-redacted");
    expect(runParams.extraSystemPrompt).not.toContain("Malik sandbox E2E");
  });
});
