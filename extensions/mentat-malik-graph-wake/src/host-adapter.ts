import { createHash, timingSafeEqual } from "node:crypto";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { OpenClawPluginApi } from "../api.js";
import {
  MALIK_SANDBOX_MAILBOX,
  isSafeSandboxWindowId,
  parseOutlookMessageNotificationResource,
  type AgentWakePostResult,
  type MalikAgentWakeRequest,
  type MalikSandboxGraphWakeDependencies,
  type MalikSandboxGraphWakeState,
  type MalikSandboxGraphWakeWindow,
  type MalikSandboxSourceScope,
  type RuntimeProfileRef,
  type ScopedSourceFetchRequest,
  type ScopedSourceFetchResult,
  type WorkflowActionRef,
} from "./bridge.js";

const NETSUITE_SANDBOX_ENVIRONMENT_ID = "netsuite-sandbox";
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const GRAPH_SELECT_FIELDS = "id,subject,receivedDateTime,internetMessageId";
const SANDBOX_WAKE_EXTRA_SYSTEM_PROMPT = [
  "You are the Malik Mentat sandbox Graph wake lane.",
  "Use only Mentat sandbox runtime/profile/provider seams for purchase_orders.create_po.",
  "Do not use old Malik email, Fleet, NetSuite, or workflow paths.",
  "Do not send vendor/customer email and do not mutate NetSuite.",
  "Do not access production systems, browser/auth/session recovery, or secret/config/env/session/token/cache/log material.",
  "Treat Microsoft Graph notifications as wake signals only, never as source authority.",
].join(" ");
const GRAPH_TOKEN_CONFIG_PATH =
  "plugins.entries.mentat-malik-graph-wake.config.graph.bearerTokenRef";

type FetchInit = {
  method: "GET";
  headers: Record<string, string>;
};

type GraphFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type MalikSandboxGraphFetch = (url: string, init: FetchInit) => Promise<GraphFetchResponse>;

export type MalikSandboxGraphWakeHostAdapterOptions = {
  api: OpenClawPluginApi;
  state: MalikSandboxGraphWakeState;
  env?: NodeJS.ProcessEnv;
  fetchGraph?: MalikSandboxGraphFetch;
  now?: () => Date;
};

type GraphConfig = {
  bearerTokenRef: unknown;
};

export function createMalikSandboxGraphWakeHostDependencies(
  options: MalikSandboxGraphWakeHostAdapterOptions,
): MalikSandboxGraphWakeDependencies {
  const env = options.env ?? process.env;
  const fetchGraph = options.fetchGraph ?? defaultGraphFetch;
  return {
    state: options.state,
    now: options.now,
    loadActiveWindow: async () => loadActiveWindow(options.api.pluginConfig),
    fetchScopedSource: async (request) =>
      await fetchScopedGraphSource({
        request,
        api: options.api,
        env,
        fetchGraph,
      }),
    postAgentWake: async (request) => await postRuntimeSubagentWake(options.api, request),
  };
}

async function defaultGraphFetch(url: string, init: FetchInit): Promise<GraphFetchResponse> {
  return await globalThis.fetch(url, init);
}

function loadActiveWindow(
  pluginConfig: OpenClawPluginApi["pluginConfig"],
): MalikSandboxGraphWakeWindow | null {
  const config = asRecord(pluginConfig);
  const activeWindow = asRecord(config?.activeWindow);
  if (!activeWindow) {
    return null;
  }

  const id = readString(activeWindow.id);
  const expiresAt = readString(activeWindow.expiresAt);
  const mailbox = readString(activeWindow.mailbox);
  const graphResourcePrefix = normalizeGraphResourcePrefix(
    readString(activeWindow.graphResourcePrefix),
  );
  const runtimeProfile = readRuntimeProfile(activeWindow.runtimeProfile);
  const netSuiteTarget = readRuntimeProfile(activeWindow.netSuiteTarget);
  const allowedActions = readAllowedActions(activeWindow.allowedActions);
  const sourceScope = readSourceScope(activeWindow.sourceScope);
  const clientStateSha256 = readSha256(activeWindow.clientStateSha256);
  if (
    !id ||
    !isSafeSandboxWindowId(id) ||
    activeWindow.approved !== true ||
    !expiresAt ||
    !mailbox ||
    !graphResourcePrefix ||
    !runtimeProfile ||
    !netSuiteTarget ||
    !sourceScope ||
    !clientStateSha256 ||
    allowedActions.length === 0
  ) {
    return null;
  }

  return {
    id,
    approved: true,
    expiresAt,
    mailbox,
    graphResourcePrefix,
    runtimeProfile,
    netSuiteTarget,
    allowedActions,
    sourceScope,
    sandboxSafeRecipientPlan: readSandboxSafeRecipientPlan(activeWindow.sandboxSafeRecipientPlan),
    verifyClientState: (clientState) => verifySha256Digest(clientState, clientStateSha256),
  };
}

async function fetchScopedGraphSource(params: {
  request: ScopedSourceFetchRequest;
  api: OpenClawPluginApi;
  env: NodeJS.ProcessEnv;
  fetchGraph: MalikSandboxGraphFetch;
}): Promise<ScopedSourceFetchResult> {
  if (params.request.mailbox !== MALIK_SANDBOX_MAILBOX) {
    return { sourceRefs: [], blockedReason: "source_outside_approved_scope" };
  }

  const graphConfig = readGraphConfig(params.api.pluginConfig);
  if (!graphConfig || !isSecretRef(graphConfig.bearerTokenRef)) {
    return { sourceRefs: [], blockedReason: "host_graph_source_unconfigured" };
  }

  const parsedResource = parseOutlookMessageNotificationResource(
    params.request.notification.resource,
  );
  if (!parsedResource) {
    return { sourceRefs: [], blockedReason: "source_outside_approved_scope" };
  }

  const resolvedToken = await resolveConfiguredSecretInputString({
    config: params.api.config,
    env: params.env,
    value: graphConfig.bearerTokenRef,
    path: GRAPH_TOKEN_CONFIG_PATH,
    unresolvedReasonStyle: "generic",
  });
  if (!resolvedToken.value) {
    return { sourceRefs: [], blockedReason: "host_graph_source_unconfigured" };
  }

  const response = await params.fetchGraph(buildGraphMessageUrl(parsedResource.messageId), {
    method: "GET",
    headers: {
      authorization: `Bearer ${resolvedToken.value}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    return {
      sourceRefs: [],
      blockedReason: "host_graph_source_unavailable",
      hostStatus: "graph_fetch_failed",
    };
  }

  const message = asRecord(await response.json());
  if (!message || !messageMatchesSourceScope(message, params.request.sourceScope)) {
    return { sourceRefs: [], blockedReason: "source_outside_approved_scope" };
  }

  const messageId = readString(message.id) ?? parsedResource.messageId;
  return {
    sourceRefs: [buildRedactedSourceRef({ mailbox: params.request.mailbox, messageId })],
  };
}

async function postRuntimeSubagentWake(
  api: OpenClawPluginApi,
  request: MalikAgentWakeRequest,
): Promise<AgentWakePostResult> {
  try {
    const result = await api.runtime.subagent.run({
      sessionKey: request.sessionKey,
      message: buildWakeMessage(request),
      deliver: false,
      lane: "subagent",
      lightContext: true,
      extraSystemPrompt: SANDBOX_WAKE_EXTRA_SYSTEM_PROMPT,
      idempotencyKey: request.idempotencyKey,
    });
    return { accepted: true, runId: result.runId };
  } catch {
    return { accepted: false, status: "runtime_subagent_rejected" };
  }
}

function buildWakeMessage(request: MalikAgentWakeRequest): string {
  const redactedNotification = {
    subscriptionIdHash: sha256Hex(request.payload.notification.subscriptionId).slice(0, 16),
    changeType: request.payload.notification.changeType,
    resourceHash: sha256Hex(request.payload.notification.resource).slice(0, 16),
  };
  return JSON.stringify({
    message: request.message,
    bridge: request.payload.bridge,
    sandboxWindowId: request.payload.sandboxWindowId,
    mailbox: request.payload.mailbox,
    runtimeProfile: request.payload.runtimeProfile,
    netSuiteTarget: request.payload.netSuiteTarget,
    workflowActions: request.payload.workflowActions,
    sourceScope: summarizeSourceScope(request.payload.sourceScope),
    sourceRefs: request.payload.sourceRefs,
    notification: redactedNotification,
    sandboxHandoff: {
      workflowAction: "purchase_orders.create_po",
      graphNotificationAuthority: "wake_only",
      expectedSideEffects: {
        emailSend: false,
        netSuiteMutation: false,
      },
      vendorNotification: "blocked_without_approved_sandbox_safe_recipient_plan",
      runtimeBoundary: "sandbox_only",
      instructions: [
        "Process only through Mentat sandbox runtime/profile/provider seams.",
        "Do not use old Malik email, Fleet, NetSuite, or workflow paths.",
        "Do not access production systems, browser/auth/session recovery, or secret/config/env/session/token/cache/log material.",
      ],
    },
  });
}

function summarizeSourceScope(sourceScope: MalikSandboxSourceScope): Record<string, boolean> {
  return {
    selectorPresent: Boolean(sourceScope.selector?.trim()),
    receivedWindowBounded: Boolean(
      sourceScope.receivedAfter?.trim() && sourceScope.receivedBefore?.trim(),
    ),
  };
}

function readGraphConfig(pluginConfig: OpenClawPluginApi["pluginConfig"]): GraphConfig | null {
  const graph = asRecord(asRecord(pluginConfig)?.graph);
  if (!graph || !("bearerTokenRef" in graph)) {
    return null;
  }
  return { bearerTokenRef: graph.bearerTokenRef };
}

function readRuntimeProfile(value: unknown): RuntimeProfileRef | null {
  const input = asRecord(value);
  const environmentClass = readString(input?.environmentClass);
  const environmentId = readString(input?.environmentId);
  if (environmentClass !== "sandbox" || environmentId !== NETSUITE_SANDBOX_ENVIRONMENT_ID) {
    return null;
  }
  return { environmentClass, environmentId };
}

function readAllowedActions(value: unknown): WorkflowActionRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const actions: WorkflowActionRef[] = [];
  for (const entry of value) {
    const input = asRecord(entry);
    const family = readString(input?.family);
    const action = readString(input?.action);
    if (family && action) {
      actions.push({ family, action });
    }
  }
  return actions;
}

function readSourceScope(value: unknown): MalikSandboxSourceScope | null {
  const input = asRecord(value);
  if (!input) {
    return null;
  }
  const selector = readString(input.selector);
  const receivedAfter = readString(input.receivedAfter);
  const receivedBefore = readString(input.receivedBefore);
  if ((receivedAfter || receivedBefore) && !hasValidTimeBounds(receivedAfter, receivedBefore)) {
    return null;
  }
  if (!selector && !receivedAfter && !receivedBefore) {
    return null;
  }
  return {
    ...(selector ? { selector } : {}),
    ...(receivedAfter ? { receivedAfter } : {}),
    ...(receivedBefore ? { receivedBefore } : {}),
  };
}

function readSandboxSafeRecipientPlan(
  value: unknown,
): MalikSandboxGraphWakeWindow["sandboxSafeRecipientPlan"] {
  const input = asRecord(value);
  if (!input || input.enabled !== true || !Array.isArray(input.recipients)) {
    return undefined;
  }
  return {
    enabled: true,
    recipients: input.recipients.flatMap((recipient) => {
      const normalized = readString(recipient);
      return normalized ? [normalized] : [];
    }),
  };
}

function buildGraphMessageUrl(messageId: string): string {
  return (
    [
      GRAPH_BASE_URL,
      "users",
      encodeURIComponent(MALIK_SANDBOX_MAILBOX),
      "messages",
      encodeURIComponent(messageId),
    ].join("/") + `?$select=${GRAPH_SELECT_FIELDS}`
  );
}

function messageMatchesSourceScope(
  message: Record<string, unknown>,
  sourceScope: MalikSandboxSourceScope,
): boolean {
  if (sourceScope.selector && !messageMatchesSelector(message, sourceScope.selector)) {
    return false;
  }

  if (sourceScope.receivedAfter || sourceScope.receivedBefore) {
    const receivedDateTime = readString(message.receivedDateTime);
    if (
      !receivedDateTime ||
      !hasValidTimeBounds(sourceScope.receivedAfter, sourceScope.receivedBefore)
    ) {
      return false;
    }
    const receivedAt = Date.parse(receivedDateTime);
    const receivedAfter = Date.parse(sourceScope.receivedAfter ?? "");
    const receivedBefore = Date.parse(sourceScope.receivedBefore ?? "");
    if (
      !Number.isFinite(receivedAt) ||
      receivedAt < receivedAfter ||
      receivedAt >= receivedBefore
    ) {
      return false;
    }
  }

  return true;
}

function messageMatchesSelector(message: Record<string, unknown>, selector: string): boolean {
  const subjectPrefix = "subject:";
  if (!selector.toLowerCase().startsWith(subjectPrefix)) {
    return false;
  }
  const expectedSubject = selector.slice(subjectPrefix.length).trim().toLowerCase();
  const subject = readString(message.subject)?.toLowerCase();
  return Boolean(expectedSubject && subject?.includes(expectedSubject));
}

function buildRedactedSourceRef(params: { mailbox: string; messageId: string }): string {
  return `graph-message:${sha256Hex(`${params.mailbox}|${params.messageId}`).slice(0, 32)}`;
}

function verifySha256Digest(value: string, expectedDigest: string): boolean {
  const actual = Buffer.from(sha256Hex(value), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasValidTimeBounds(
  receivedAfter: string | undefined,
  receivedBefore: string | undefined,
): boolean {
  if (!receivedAfter || !receivedBefore) {
    return false;
  }
  const after = Date.parse(receivedAfter);
  const before = Date.parse(receivedBefore);
  return Number.isFinite(after) && Number.isFinite(before) && after < before;
}

function normalizeGraphResourcePrefix(value: string | undefined): string | undefined {
  return value?.replace(/^\/+/, "").replace(/\/+$/, "");
}

function readSha256(value: unknown): string | undefined {
  const normalized = readString(value)?.toLowerCase();
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
