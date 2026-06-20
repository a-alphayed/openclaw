import { describe, expect, it, vi } from "vitest";
import {
  MALIK_SANDBOX_MAILBOX,
  createMalikSandboxGraphWakeState,
  handleMalikSandboxGraphWakeRequest,
  type MalikSandboxGraphWakeDependencies,
  type MalikSandboxGraphWakeWindow,
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

function graphNotification(clientState = "expected-client-state") {
  return {
    value: [
      {
        subscriptionId: "subscription-redacted",
        clientState,
        changeType: "created",
        resource: "users/malik-mentat@outlook.com/mailFolders/inbox/messages/AAMk-redacted",
      },
    ],
  };
}

function createDeps(params?: {
  window?: MalikSandboxGraphWakeWindow | null;
  sourceRefs?: string[];
  fetchDelay?: Promise<void>;
}): MalikSandboxGraphWakeDependencies {
  const activeWindow = params && "window" in params ? params.window : windowFixture();
  return {
    state: createMalikSandboxGraphWakeState(),
    now: () => new Date("2026-06-20T17:30:00.000Z"),
    loadActiveWindow: vi.fn(async () => activeWindow),
    fetchScopedSource: vi.fn(async () => {
      if (params?.fetchDelay) {
        await params.fetchDelay;
      }
      return { sourceRefs: params?.sourceRefs ?? ["source-ref-redacted"] };
    }),
    postAgentWake: vi.fn(async () => ({ accepted: true, runId: "run-redacted" })),
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
    expect(deps.postAgentWake).not.toHaveBeenCalled();
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

    expect(response.body).toMatchObject({ ok: true, status: "wake_posted" });
    expect(deps.fetchScopedSource).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
  });

  it("fetches only the approved scoped source before posting the bounded wake", async () => {
    const deps = createDeps();

    const response = await postNotification(deps);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: "wake_posted",
      runId: "run-redacted",
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
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
    const wakeRequest = vi.mocked(deps.postAgentWake).mock.calls[0][0];
    expect(wakeRequest.idempotencyKey).toMatch(/^malik-sandbox-graph-wake:/);
    expect(wakeRequest.sessionKey).toBe("mentat:malik:sandbox:sandbox-window-2026-06-20");
    expect(wakeRequest.payload).toMatchObject({
      mailbox: MALIK_SANDBOX_MAILBOX,
      runtimeProfile: {
        environmentClass: "sandbox",
        environmentId: "netsuite-sandbox",
      },
      workflowActions: [{ family: "purchase_orders", action: "create_po" }],
      sourceRefs: ["source-ref-redacted"],
    });
  });

  it("deduplicates repeated notifications by idempotency key", async () => {
    const deps = createDeps();

    await postNotification(deps);
    const response = await postNotification(deps);

    expect(response.body).toMatchObject({ ok: true, status: "duplicate" });
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
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
    expect(firstResponse.body).toMatchObject({ ok: true, status: "wake_posted" });
    expect(deps.fetchScopedSource).toHaveBeenCalledTimes(1);
    expect(deps.postAgentWake).toHaveBeenCalledTimes(1);
  });
});
