import { createHash } from "node:crypto";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  MALIK_SANDBOX_OPENCLAW_AGENT_ID,
  MALIK_SANDBOX_MAILBOX,
  createMalikSandboxGraphWakeState,
  handleMalikSandboxGraphWakeRequest,
  type MalikSandboxGraphWakeDependencies,
  type MalikAgentWakeRequest,
  type MentatSandboxWorkflowRunResult,
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

function sandboxAgentConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
    workspace: "~/openclaw/malik-mentat-sandbox-workspace",
    agentDir: "~/openclaw/malik-mentat-sandbox-agent",
    sandbox: {
      mode: "all",
      workspaceAccess: "none",
    },
    tools: {
      profile: "minimal",
      fs: {
        workspaceOnly: true,
      },
      deny: ["group:messaging", "group:runtime", "group:web", "group:sessions"],
    },
    ...overrides,
  };
}

function openClawConfigFixture(params?: {
  sandboxAgent?: Record<string, unknown> | null;
  sandboxAgents?: Record<string, unknown>[];
  legacyAgent?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const legacyAgent =
    params && "legacyAgent" in params
      ? params.legacyAgent
      : {
          id: "malik",
          workspace: "~/openclaw/malik-legacy-workspace",
          agentDir: "~/openclaw/malik-legacy-agent",
        };
  const sandboxAgent =
    params && "sandboxAgent" in params ? params.sandboxAgent : sandboxAgentConfig();
  const sandboxAgents =
    params && "sandboxAgents" in params ? params.sandboxAgents : sandboxAgent ? [sandboxAgent] : [];
  return {
    agents: {
      list: [legacyAgent, ...sandboxAgents].filter(Boolean),
    },
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
  openClawConfig?: Record<string, unknown>;
  scheduleSessionTurn?: ReturnType<typeof vi.fn>;
  runnerResult?: MentatSandboxWorkflowRunResult;
  runMentatSandboxWorkflow?: ReturnType<typeof vi.fn> | null;
}): {
  deps: MalikSandboxGraphWakeDependencies;
  fetchGraph: ReturnType<typeof vi.fn>;
  scheduleSessionTurn: ReturnType<typeof vi.fn>;
  subagentRun: ReturnType<typeof vi.fn>;
  runMentatSandboxWorkflow: ReturnType<typeof vi.fn>;
} {
  const scheduleSessionTurn =
    params?.scheduleSessionTurn ?? vi.fn(async () => ({ id: "wake-redacted" }));
  const subagentRun = vi.fn(async () => ({ runId: "run-redacted" }));
  const defaultRunner = vi.fn(
    async () =>
      params?.runnerResult ?? {
        ok: true,
        status: "open",
        redacted: true,
        proofScope: "graph_wake_to_mentat_no_live_workflow",
        handlingStage: "created_waiting_on_approval",
      },
  );
  const runMentatSandboxWorkflow =
    params && "runMentatSandboxWorkflow" in params
      ? params.runMentatSandboxWorkflow
      : defaultRunner;
  const fetchGraph = vi.fn(async () => ({
    ok: params?.graphOk ?? true,
    status: params?.graphOk === false ? 404 : 200,
    json: async () => params?.graphResponse ?? graphMessage(),
  })) satisfies MalikSandboxGraphFetch;
  const api = createTestPluginApi({
    pluginConfig: params?.config ?? pluginConfig(),
    config: (params?.openClawConfig ?? openClawConfigFixture()) as OpenClawPluginApi["config"],
    scheduleSessionTurn,
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
    ...(runMentatSandboxWorkflow ? { runMentatSandboxWorkflow } : {}),
    now: () => new Date("2026-06-20T17:30:00.000Z"),
    state: createMalikSandboxGraphWakeState(),
  });
  return {
    deps,
    fetchGraph,
    scheduleSessionTurn,
    subagentRun,
    runMentatSandboxWorkflow: runMentatSandboxWorkflow ?? defaultRunner,
  };
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

  it("fails closed before Graph fetch when the dedicated sandbox agent is missing", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({
      openClawConfig: openClawConfigFixture({ sandboxAgent: null }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_wake_target_unavailable",
      restrictedWakeTarget: {
        agentEntryPresent: false,
        dedicatedAgentId: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
        rawValuesRedacted: true,
      },
    });
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("fails closed before Graph fetch when dedicated sandbox agent entries are duplicated", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({
      openClawConfig: openClawConfigFixture({
        sandboxAgents: [
          sandboxAgentConfig({ workspace: "~/openclaw/first-sandbox-workspace" }),
          sandboxAgentConfig({ workspace: "~/openclaw/second-sandbox-workspace" }),
        ],
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_wake_target_not_restricted",
      restrictedWakeTarget: {
        agentEntryPresent: true,
        agentIdValidated: false,
        rawValuesRedacted: true,
      },
    });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain("first-sandbox-workspace");
    expect(body).not.toContain("second-sandbox-workspace");
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated sandbox agent shares legacy Malik paths", async () => {
    const { deps, fetchGraph, subagentRun } = createHarness({
      openClawConfig: openClawConfigFixture({
        legacyAgent: {
          id: "malik",
          workspace: "~/openclaw/shared-malik-workspace",
          agentDir: "~/openclaw/shared-malik-agent",
        },
        sandboxAgent: sandboxAgentConfig({
          workspace: "~/openclaw/shared-malik-workspace",
          agentDir: "~/openclaw/shared-malik-agent",
        }),
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_wake_target_not_restricted",
      restrictedWakeTarget: {
        workspaceDistinctFromMalik: false,
        agentDirDistinctFromMalik: false,
        rawValuesRedacted: true,
      },
    });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain("shared-malik-workspace");
    expect(body).not.toContain("shared-malik-agent");
    expect(fetchGraph).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("requires absolute sandbox and tool guardrails on the dedicated agent", async () => {
    const cases = [
      {
        label: "writable workspace access",
        sandboxAgent: sandboxAgentConfig({ sandbox: { mode: "all", workspaceAccess: "rw" } }),
        expected: { workspaceAccessRestricted: false },
      },
      {
        label: "sandbox off",
        sandboxAgent: sandboxAgentConfig({ sandbox: { mode: "off", workspaceAccess: "none" } }),
        expected: { sandboxEnabled: false },
      },
      {
        label: "non-minimal tools",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "coding",
            fs: { workspaceOnly: true },
            deny: ["group:messaging", "group:runtime", "group:web", "group:sessions"],
          },
        }),
        expected: { toolsProfileMinimal: false },
      },
      {
        label: "filesystem not workspace-only",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "minimal",
            fs: { workspaceOnly: false },
            deny: ["group:messaging", "group:runtime", "group:web", "group:sessions"],
          },
        }),
        expected: { fsWorkspaceOnly: false },
      },
      {
        label: "missing concrete risky capability denial",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "minimal",
            fs: { workspaceOnly: true },
            deny: ["group:messaging", "group:runtime", "group:web"],
          },
        }),
        expected: { riskyCapabilitiesDenied: false },
      },
      {
        label: "partial outbound send denial",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "minimal",
            fs: { workspaceOnly: true },
            deny: ["message", "group:runtime", "group:web", "group:sessions"],
          },
        }),
        expected: { riskyCapabilitiesDenied: false },
      },
      {
        label: "partial runtime denial",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "minimal",
            fs: { workspaceOnly: true },
            deny: ["group:messaging", "exec", "group:web", "group:sessions"],
          },
        }),
        expected: { riskyCapabilitiesDenied: false },
      },
      {
        label: "partial egress denial",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "minimal",
            fs: { workspaceOnly: true },
            deny: ["group:messaging", "group:runtime", "browser", "group:sessions"],
          },
        }),
        expected: { riskyCapabilitiesDenied: false },
      },
      {
        label: "partial spawn denial",
        sandboxAgent: sandboxAgentConfig({
          tools: {
            profile: "minimal",
            fs: { workspaceOnly: true },
            deny: ["group:messaging", "group:runtime", "group:web", "subagents"],
          },
        }),
        expected: { riskyCapabilitiesDenied: false },
      },
    ];

    for (const testCase of cases) {
      const { deps, fetchGraph, subagentRun } = createHarness({
        openClawConfig: openClawConfigFixture({ sandboxAgent: testCase.sandboxAgent }),
      });

      const response = await postNotification(deps);

      expect(response.body, testCase.label).toMatchObject({
        ok: false,
        status: "blocked",
        reason: "sandbox_wake_target_not_restricted",
        restrictedWakeTarget: {
          ...testCase.expected,
          rawValuesRedacted: true,
        },
      });
      expect(fetchGraph).not.toHaveBeenCalled();
      expect(subagentRun).not.toHaveBeenCalled();
    }
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

    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
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

    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
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

    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
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

  it("blocks when the deterministic Mentat runner rejects before host scheduling", async () => {
    const { deps, scheduleSessionTurn, runMentatSandboxWorkflow } = createHarness({
      runnerResult: {
        ok: false,
        status: "failed",
        redacted: true,
        failure: { code: "host_wake_preflight_failed" },
      },
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "mentat_runner_rejected",
      hostStatus: "host_wake_preflight_failed",
    });
    expect(runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("redacts raw subprocess runner failure output before response fields", async () => {
    const rawCode = "Bearer raw /Users/example clientState detail";
    const subprocessScript = [
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--output') + 1];",
      `fs.writeFileSync(out, JSON.stringify({ ok: false, status: 'failed', redacted: true, failure: { code: ${JSON.stringify(rawCode)} } }));`,
    ].join(" ");
    const { deps, scheduleSessionTurn } = createHarness({
      config: pluginConfig({
        mentatRunner: {
          command: "node",
          args: ["-e", subprocessScript, "--"],
          roleBindingId: "binding-malik-sandbox-graph-wake-runner",
          engineDataRoot: "/redacted/state",
          rolePackPath: "/redacted/role-pack",
          roleKbPath: "/redacted/role-kb",
        },
      }),
      runMentatSandboxWorkflow: null,
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "mentat_runner_rejected",
      hostStatus: "mentat_runner_failed",
    });
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("/Users/example");
    expect(rendered).not.toContain("clientState");
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("blocks when the host scheduler rejects the wake", async () => {
    const scheduleSessionTurn = vi.fn(async () => {
      throw new Error("scheduler rejected with raw detail");
    });
    const { deps, scheduleSessionTurn: scheduleMock } = createHarness({ scheduleSessionTurn });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "host_poster_rejected",
      hostStatus: "host_scheduler_rejected",
    });
    expect(JSON.stringify(response.body)).not.toContain("raw detail");
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("blocks when the host scheduler returns no handle", async () => {
    const scheduleSessionTurn = vi.fn(async () => undefined);
    const { deps } = createHarness({ scheduleSessionTurn });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "host_poster_rejected",
      hostStatus: "host_scheduler_rejected",
    });
  });

  it("fails closed when the scheduler wake session key agent is not dedicated", async () => {
    const { deps, scheduleSessionTurn } = createHarness();

    const result = await deps.postAgentWake({
      message: "Mentat Malik sandbox Graph webhook wake",
      sessionKey: "agent:malik:subagent:mentat-sandbox-sandbox-window-2026-06-20",
      wakeMode: "isolated",
      deliver: false,
      idempotencyKey: "malik-sandbox-graph-wake:test-mismatched-agent",
      payload: {
        bridge: "microsoft_graph_webhook",
        sandboxWindowId: "sandbox-window-2026-06-20",
        mailbox: MALIK_SANDBOX_MAILBOX,
        runtimeProfile: {
          environmentClass: "sandbox",
          environmentId: "netsuite-sandbox",
        },
        netSuiteTarget: {
          environmentClass: "sandbox",
          environmentId: "netsuite-sandbox",
        },
        workflowActions: [{ family: "purchase_orders", action: "create_po" }],
        sourceScope: {
          selector: "subject:Malik sandbox E2E",
          receivedAfter: "2026-06-20T17:00:00.000Z",
          receivedBefore: "2026-06-20T18:00:00.000Z",
        },
        sourceRefs: ["source-ref-redacted"],
        notification: {
          subscriptionId: "subscription-redacted",
          changeType: "created",
          resource: GRAPH_RESOURCE,
        },
        restrictedWakeTarget: {
          agentIdValidated: true,
          sessionKeyAgentIdMatchesValidatedAgent: false,
          agentEntryPresent: true,
          dedicatedAgentId: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
          explicitWorkspace: true,
          explicitAgentDir: true,
          workspaceDistinctFromMalik: true,
          agentDirDistinctFromMalik: true,
          sandboxEnabled: true,
          workspaceAccessRestricted: true,
          toolsProfileMinimal: true,
          fsWorkspaceOnly: true,
          riskyCapabilitiesDenied: true,
          rawValuesRedacted: true,
        },
        mentatRunner: {
          status: "open",
          proofScope: "graph_wake_to_mentat_no_live_workflow",
          handlingStage: "created_waiting_on_approval",
          redacted: true,
        },
      },
    } satisfies MalikAgentWakeRequest);

    expect(result).toEqual({ accepted: false, status: "host_scheduler_agent_mismatch" });
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("schedules the wake through host scheduler with no delivery and a bounded wake id", async () => {
    const { deps, scheduleSessionTurn, subagentRun, runMentatSandboxWorkflow } = createHarness();

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: true,
      status: "wake_scheduled",
    });
    const wakeId = (response.body as { wakeId?: unknown }).wakeId;
    expect(typeof wakeId).toBe("string");
    const wakeIdString = wakeId as string;
    expect(wakeIdString).toMatch(/^[a-f0-9]{32}$/);
    expect(wakeIdString).not.toBe("wake-redacted");
    expect(JSON.stringify(response.body)).not.toContain("wake-redacted");

    expect(runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    const runnerInput = runMentatSandboxWorkflow.mock.calls[0][0];
    expect(runnerInput).toMatchObject({
      workflowFamily: "purchase_orders.create_po",
      sourceBinding: { sourceId: "malik-email-inbox", mailbox: MALIK_SANDBOX_MAILBOX },
      hostWakeProof: {
        proofMode: "host_redacted_sandbox_graph_wake",
        proofScope: "wake_scheduled_only",
      },
      sources: [
        expect.objectContaining({
          providerId: "email",
          sourceType: "email_thread",
          subject: "Malik sandbox E2E PO create",
        }),
      ],
    });
    const renderedRunnerInput = JSON.stringify(runnerInput);
    expect(renderedRunnerInput).not.toContain(FAKE_GRAPH_TOKEN);
    expect(renderedRunnerInput).not.toContain(EXPECTED_CLIENT_STATE);
    expect(renderedRunnerInput).not.toContain("MENTAT_MALIK_GRAPH_TOKEN");

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(subagentRun).not.toHaveBeenCalled();
    const [scheduleParams] = scheduleSessionTurn.mock.calls[0];
    expect(scheduleParams).toMatchObject({
      sessionKey: "agent:malik-mentat-sandbox:subagent:mentat-sandbox-sandbox-window-2026-06-20",
      agentId: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
      delayMs: 1,
      deleteAfterRun: true,
      deliveryMode: "none",
      tag: "malik-sandbox-wake",
    });
    expect(scheduleParams.name).toMatch(/^malik-sandbox-wake-[a-f0-9]{32}$/);
    expect(scheduleParams.name).toBe(`malik-sandbox-wake-${wakeIdString}`);
    expect(scheduleParams.name).not.toContain(":");
    expect(scheduleParams.tag).not.toContain(":");
    expect(scheduleParams.message).toContain("Mentat Malik sandbox Graph webhook wake");
    expect(scheduleParams.message).toContain("operator_visible_marker_only");
    expect(scheduleParams.message).toContain("deterministic Mentat runner has already handled");
    expect(scheduleParams.message).toContain("non-load-bearing marker");
    expect(scheduleParams.message).toContain("purchase_orders.create_po");
    expect(scheduleParams.message).toContain('"graphNotificationAuthority":"wake_only"');
    expect(scheduleParams.message).toContain('"deterministicMentatRunner":{"status":"open"');
    expect(scheduleParams.message).toContain('"emailSend":false');
    expect(scheduleParams.message).toContain('"netSuiteMutation":false');
    expect(scheduleParams.message).toContain(
      "blocked_without_approved_sandbox_safe_recipient_plan",
    );
    expect(scheduleParams.message).toContain(
      `"dedicatedAgentId":"${MALIK_SANDBOX_OPENCLAW_AGENT_ID}"`,
    );
    expect(scheduleParams.message).toContain('"sessionKeyAgentIdMatchesValidatedAgent":true');
    expect(scheduleParams.message).toContain('"riskyCapabilitiesDenied":true');
    expect(scheduleParams.message).toContain('"rawValuesRedacted":true');
    expect(scheduleParams.message).not.toContain(FAKE_GRAPH_TOKEN);
    expect(scheduleParams.message).not.toContain(EXPECTED_CLIENT_STATE);
    expect(scheduleParams.message).not.toContain("AAMk-redacted");
    expect(scheduleParams.message).not.toContain("Malik sandbox E2E");
    expect(scheduleParams.message).not.toContain("malik-mentat-sandbox-workspace");
    expect(scheduleParams.message).not.toContain("malik-mentat-sandbox-agent");
  });

  it("omits raw runner handling stages from scheduled marker messages", async () => {
    const rawStage = "Bearer raw /tmp/clientState detail";
    const { deps, scheduleSessionTurn } = createHarness({
      runnerResult: {
        ok: true,
        status: "open",
        redacted: true,
        proofScope: "graph_wake_to_mentat_no_live_workflow",
        handlingStage: rawStage,
      },
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    const renderedResponse = JSON.stringify(response.body);
    expect(renderedResponse).not.toContain("Bearer");
    expect(renderedResponse).not.toContain("/tmp/clientState");
    const [scheduleParams] = scheduleSessionTurn.mock.calls[0];
    expect(scheduleParams.message).toContain("deterministicMentatRunner");
    expect(scheduleParams.message).not.toContain("Bearer");
    expect(scheduleParams.message).not.toContain("/tmp/clientState");
    expect(scheduleParams.message).not.toContain(rawStage);
  });

  it("does not schedule a second turn for duplicate notifications", async () => {
    const { deps, scheduleSessionTurn } = createHarness();

    const first = await postNotification(deps);
    const second = await postNotification(deps);

    expect(first.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    const wakeId = (first.body as { wakeId?: unknown }).wakeId;
    expect(typeof wakeId).toBe("string");
    const wakeIdString = wakeId as string;
    expect(wakeIdString).toMatch(/^[a-f0-9]{32}$/);
    expect(wakeIdString).not.toBe("wake-redacted");
    expect(second.body).toMatchObject({ ok: true, status: "duplicate", wakeId: wakeIdString });
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second.body)).not.toContain("wake-redacted");
  });
});
