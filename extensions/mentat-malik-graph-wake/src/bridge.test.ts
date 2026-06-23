import { describe, expect, it, vi } from "vitest";
import {
  MALIK_SANDBOX_OPENCLAW_AGENT_ID,
  MALIK_SANDBOX_MAILBOX,
  createMalikSandboxGraphWakeState,
  handleMalikSandboxGraphWakeRequest,
  isSafeSandboxWindowId,
  type MalikSandboxGraphWakeDependencies,
  type MalikSandboxGraphWakeWindow,
  type RestrictedWakeTargetProof,
  type ScopedMentatSourceRecord,
  type MentatSandboxWorkflowRunResult,
} from "./bridge.js";

function windowFixture(
  overrides?: Partial<MalikSandboxGraphWakeWindow>,
): MalikSandboxGraphWakeWindow {
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
    verifyClientState: (value) => value === "expected-client-state",
    ...overrides,
  };
}

function graphNotification(
  clientState = "expected-client-state",
  resource = "users/malik-mentat@outlook.com/mailFolders/inbox/messages/AAMk-redacted",
) {
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

function sourceRecord(id = "graph-wake-source-redacted"): ScopedMentatSourceRecord {
  return {
    id,
    providerId: "email",
    externalId: "graph-message:redacted",
    sourceType: "email_thread",
    receivedAt: "2026-06-20T17:30:00.000Z",
    subject: "Malik sandbox E2E PO create",
    summary: "Scoped redacted source content.",
    rawRef: "graph-message:redacted",
    artifactRefs: [],
    handledStatus: "new",
    metadata: {
      email: {
        provider: "microsoft_graph",
        accountId: MALIK_SANDBOX_MAILBOX,
        threadId: "thread-redacted",
        messageIds: ["message-redacted"],
        receivedAt: "2026-06-20T17:30:00.000Z",
        parentFolderId: "inbox",
        to: [{ name: "Malik sandbox mailbox", address: MALIK_SANDBOX_MAILBOX }],
      },
    },
    runtimeProfile: {
      runtimeProfileId: "malik-sandbox-graph-wake",
      environmentClass: "sandbox",
      environmentId: "netsuite-sandbox",
      sourceProfileId: "malik-mentat-outlook-inbox",
    },
  };
}

function runnerResult(
  overrides?: Partial<MentatSandboxWorkflowRunResult>,
): MentatSandboxWorkflowRunResult {
  return {
    ok: true,
    status: "open",
    redacted: true,
    proofScope: "graph_wake_to_mentat_no_live_workflow",
    handlingStage: "created_waiting_on_approval",
    ...overrides,
  };
}

function restrictedWakeTargetProof(
  overrides?: Partial<RestrictedWakeTargetProof>,
): RestrictedWakeTargetProof {
  return {
    agentIdValidated: true,
    sessionKeyAgentIdMatchesValidatedAgent: true,
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
    ...overrides,
  };
}

function createDeps(params?: {
  window?: MalikSandboxGraphWakeWindow | null;
  sourceRefs?: string[];
  sources?: ScopedMentatSourceRecord[];
  fetchDelay?: Promise<void>;
  runner?: MentatSandboxWorkflowRunResult;
  targetProof?: RestrictedWakeTargetProof;
  targetValidationOk?: boolean;
}): MalikSandboxGraphWakeDependencies {
  const activeWindow = params && "window" in params ? params.window : windowFixture();
  const targetProof = params?.targetProof ?? restrictedWakeTargetProof();
  return {
    state: createMalikSandboxGraphWakeState(),
    now: () => new Date("2026-06-20T17:30:00.000Z"),
    loadActiveWindow: vi.fn(async () => activeWindow),
    validateWakeTarget: vi.fn(async () =>
      params?.targetValidationOk === false
        ? {
            ok: false,
            reason: "sandbox_wake_target_not_restricted",
            proof: targetProof,
          }
        : {
            ok: true,
            proof: targetProof,
          },
    ),
    fetchScopedSource: vi.fn(async () => {
      if (params?.fetchDelay) {
        await params.fetchDelay;
      }
      return {
        sourceRefs: params?.sourceRefs ?? ["source-ref-redacted"],
        sources: params?.sources ?? [sourceRecord()],
      };
    }),
    runMentatSandboxWorkflow: vi.fn(async () => params?.runner ?? runnerResult()),
    postAgentWake: vi.fn(async () => ({ accepted: true, wakeId: "wake-redacted" })),
  };
}

async function postNotification(
  deps: MalikSandboxGraphWakeDependencies,
  body = graphNotification(),
) {
  return handleMalikSandboxGraphWakeRequest(
    {
      method: "POST",
      url: "/plugins/mentat/malik-sandbox-graph-wake",
      body: JSON.stringify(body),
    },
    deps,
  );
}

describe("Malik sandbox Graph wake bridge", () => {
  it("echoes Graph validation tokens as text/plain without waking", async () => {
    const deps = createDeps();

    const response = await handleMalikSandboxGraphWakeRequest(
      {
        method: "GET",
        url: "/plugins/mentat/malik-sandbox-graph-wake?validationToken=hello%20sandbox",
      },
      deps,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.body).toBe("hello sandbox");
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("accepts Graph message resources even though graphResourcePrefix is subscription scope", async () => {
    const deps = createDeps();

    const response = await postNotification(
      deps,
      graphNotification(
        "expected-client-state",
        "users/opaque-user-segment/messages/AAMk-redacted",
      ),
    );

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    expect(deps.fetchScopedSource).toHaveBeenCalledTimes(1);
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
  });

  it("fails closed when there is no active approved sandbox window", async () => {
    const deps = createDeps({ window: null });

    const response = await postNotification(deps);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_window_unavailable",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("rejects unsafe sandbox window ids before fetching source", async () => {
    const deps = createDeps({
      window: windowFixture({ id: "sandbox-window:unsafe" }),
    });

    const response = await postNotification(deps);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_window_id_invalid",
    });
    expect(isSafeSandboxWindowId("sandbox-window-2026-06-20")).toBe(true);
    expect(isSafeSandboxWindowId("sandbox-window:unsafe")).toBe(false);
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("validates clientState without echoing the provided value", async () => {
    const deps = createDeps();

    const response = await postNotification(deps, graphNotification("wrong-client-state"));

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "client_state_mismatch",
    });
    expect(JSON.stringify(response.body)).not.toContain("wrong-client-state");
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("rejects production runtime profile windows before fetching source", async () => {
    const deps = createDeps({
      window: windowFixture({
        runtimeProfile: {
          environmentClass: "production",
          environmentId: "netsuite-production",
        },
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "runtime_profile_not_sandbox",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
  });

  it("blocks vendor notification without a sandbox-safe recipient plan", async () => {
    const deps = createDeps({
      window: windowFixture({
        allowedActions: [{ family: "purchase_orders", action: "vendor_notification" }],
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "vendor_notification_recipient_plan_required",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("blocks vendor notification when the sandbox-safe recipient plan has no recipients", async () => {
    const deps = createDeps({
      window: windowFixture({
        allowedActions: [{ family: "purchase_orders", action: "vendor_notification" }],
        sandboxSafeRecipientPlan: {
          enabled: true,
          recipients: [],
        },
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "vendor_notification_recipient_plan_required",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("validates the restricted wake target before fetching source", async () => {
    const targetProof = restrictedWakeTargetProof({ riskyCapabilitiesDenied: false });
    const deps = createDeps({
      targetProof,
      targetValidationOk: false,
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "sandbox_wake_target_not_restricted",
      restrictedWakeTarget: {
        riskyCapabilitiesDenied: false,
        rawValuesRedacted: true,
      },
    });
    expect(deps.validateWakeTarget).toHaveBeenCalledWith({
      expectedAgentId: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
      sessionKey: "agent:malik-mentat-sandbox:subagent:mentat-sandbox-sandbox-window-2026-06-20",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("requires a complete approved source time window when no selector is present", async () => {
    const deps = createDeps({
      window: windowFixture({
        sourceScope: {
          receivedAfter: "2026-06-20T17:00:00.000Z",
        },
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "source_scope_unavailable",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("allows a complete approved source time window without a selector", async () => {
    const deps = createDeps({
      window: windowFixture({
        sourceScope: {
          receivedAfter: "2026-06-20T17:00:00.000Z",
          receivedBefore: "2026-06-20T18:00:00.000Z",
        },
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    expect(deps.fetchScopedSource).toHaveBeenCalledTimes(1);
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
  });

  it("rejects non-message Graph resources before fetching source", async () => {
    const deps = createDeps();

    const response = await postNotification(
      deps,
      graphNotification("expected-client-state", "users/opaque-user-segment/events/AAMk-redacted"),
    );

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "notification_resource_not_approved",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("rejects reversed approved source time bounds even when a selector is present", async () => {
    const deps = createDeps({
      window: windowFixture({
        sourceScope: {
          selector: "subject:Malik sandbox E2E",
          receivedAfter: "2026-06-20T18:00:00.000Z",
          receivedBefore: "2026-06-20T17:00:00.000Z",
        },
      }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "source_scope_unavailable",
    });
    expect(deps.fetchScopedSource).not.toHaveBeenCalled();
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("fetches only the approved scoped source before posting the bounded wake", async () => {
    const deps = createDeps();

    const response = await postNotification(deps);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: "wake_scheduled",
      wakeId: "wake-redacted",
    });
    expect(deps.fetchScopedSource).toHaveBeenCalledWith({
      mailbox: MALIK_SANDBOX_MAILBOX,
      sourceScope: {
        selector: "subject:Malik sandbox E2E",
        receivedAfter: "2026-06-20T17:00:00.000Z",
        receivedBefore: "2026-06-20T18:00:00.000Z",
      },
      notification: {
        changeType: "created",
        resource: "users/malik-mentat@outlook.com/mailFolders/inbox/messages/AAMk-redacted",
        subscriptionId: "subscription-redacted",
      },
      sandboxWindowId: "sandbox-window-2026-06-20",
    });
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
    const wakeRequest = vi.mocked(deps.postAgentWake).mock.calls[0][0];
    expect(wakeRequest.idempotencyKey).toMatch(/^malik-sandbox-graph-wake:/);
    expect(wakeRequest.sessionKey).toBe(
      "agent:malik-mentat-sandbox:subagent:mentat-sandbox-sandbox-window-2026-06-20",
    );
    expect(wakeRequest.sessionKey).toMatch(
      /^agent:malik-mentat-sandbox:subagent:mentat-sandbox-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
    );
    expect(wakeRequest.sessionKey).not.toContain("agent:malik:mentat-sandbox:");
    expect(wakeRequest.payload).toMatchObject({
      mailbox: MALIK_SANDBOX_MAILBOX,
      runtimeProfile: {
        environmentClass: "sandbox",
        environmentId: "netsuite-sandbox",
      },
      workflowActions: [{ family: "purchase_orders", action: "create_po" }],
      sourceRefs: ["source-ref-redacted"],
      restrictedWakeTarget: restrictedWakeTargetProof(),
      mentatRunner: {
        status: "open",
        proofScope: "graph_wake_to_mentat_no_live_workflow",
        handlingStage: "created_waiting_on_approval",
        redacted: true,
      },
    });
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowFamily: "purchase_orders.create_po",
        sourceBinding: { sourceId: "malik-email-inbox", mailbox: MALIK_SANDBOX_MAILBOX },
        sourceRefs: ["source-ref-redacted"],
        sources: [expect.objectContaining({ id: "graph-wake-source-redacted" })],
        hostWakeProof: expect.objectContaining({
          proofMode: "host_redacted_sandbox_graph_wake",
          proofScope: "wake_scheduled_only",
        }),
      }),
    );
    expect(response.body).toMatchObject({
      restrictedWakeTarget: restrictedWakeTargetProof(),
      mentatRunner: { status: "open", redacted: true },
    });
  });

  it("keeps sandbox subagent keys unique per approved window id", async () => {
    const firstDeps = createDeps({
      window: windowFixture({ id: "sandbox-window-A" }),
    });
    const secondDeps = createDeps({
      window: windowFixture({ id: "sandbox-window-B" }),
    });

    await postNotification(firstDeps);
    await postNotification(secondDeps);

    const firstWake = vi.mocked(firstDeps.postAgentWake).mock.calls[0][0];
    const secondWake = vi.mocked(secondDeps.postAgentWake).mock.calls[0][0];
    expect(firstWake.sessionKey).toBe(
      "agent:malik-mentat-sandbox:subagent:mentat-sandbox-sandbox-window-A",
    );
    expect(secondWake.sessionKey).toBe(
      "agent:malik-mentat-sandbox:subagent:mentat-sandbox-sandbox-window-B",
    );
    expect(firstWake.sessionKey).not.toBe(secondWake.sessionKey);
    for (const key of [firstWake.sessionKey, secondWake.sessionKey]) {
      expect(key).toMatch(
        /^agent:malik-mentat-sandbox:subagent:mentat-sandbox-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
      );
    }
  });

  it("blocks when the deterministic Mentat runner rejects before scheduling", async () => {
    const deps = createDeps({
      runner: {
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
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("redacts untrusted runner failure codes before response fields", async () => {
    const deps = createDeps({
      runner: {
        ok: false,
        status: "failed",
        redacted: true,
        failure: { code: "Bearer raw /Users/example clientState detail" },
      },
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
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("omits untrusted runner handling stages from response and wake payload", async () => {
    const deps = createDeps({
      runner: runnerResult({ handlingStage: "Bearer raw /tmp/clientState detail" }),
    });

    const response = await postNotification(deps);

    expect(response.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("/tmp/clientState");
    const mentatRunner = (response.body as { mentatRunner?: Record<string, unknown> }).mentatRunner;
    expect(mentatRunner).toMatchObject({ status: "open", redacted: true });
    expect(mentatRunner).not.toHaveProperty("handlingStage");
    const wakeRequest = vi.mocked(deps.postAgentWake).mock.calls[0][0];
    expect(wakeRequest.payload.mentatRunner).not.toHaveProperty("handlingStage");
  });

  it("blocks when the approved scoped source is empty", async () => {
    const deps = createDeps({ sourceRefs: [] });

    const response = await postNotification(deps);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: false,
      status: "blocked",
      reason: "source_scope_empty",
    });
    expect(deps.fetchScopedSource).toHaveBeenCalledTimes(1);
    expect(deps.runMentatSandboxWorkflow).not.toHaveBeenCalled();
    expect(deps.postAgentWake).not.toHaveBeenCalled();
  });

  it("deduplicates repeated notifications by idempotency key", async () => {
    const deps = createDeps();

    await postNotification(deps);
    const response = await postNotification(deps);

    expect(response.body).toMatchObject({
      ok: true,
      status: "duplicate",
      wakeId: "wake-redacted",
    });
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
  });

  it("deduplicates accepted resource shape variants by parsed message id", async () => {
    const deps = createDeps();

    const first = await postNotification(
      deps,
      graphNotification("expected-client-state", "users/opaque-one/messages/AAMk-same-message"),
    );
    const second = await postNotification(
      deps,
      graphNotification("expected-client-state", "Users/opaque-two/Messages/AAMk-same-message"),
    );

    expect(first.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    expect(second.body).toMatchObject({ ok: true, status: "duplicate" });
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
    expect((second.body as Record<string, unknown>).idempotencyKey).toBe(
      (first.body as Record<string, unknown>).idempotencyKey,
    );
  });

  it("coalesces concurrent notifications through single-flight", async () => {
    let releaseFetch: (() => void) | undefined;
    const fetchDelay = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const deps = createDeps({ fetchDelay });

    const first = postNotification(deps);
    const second = await postNotification(deps);
    releaseFetch?.();
    const firstResponse = await first;

    expect(second.body).toMatchObject({ ok: true, status: "coalesced" });
    expect(firstResponse.body).toMatchObject({ ok: true, status: "wake_scheduled" });
    expect(deps.fetchScopedSource).toHaveBeenCalledTimes(1);
    expect(deps.runMentatSandboxWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
  });
});
