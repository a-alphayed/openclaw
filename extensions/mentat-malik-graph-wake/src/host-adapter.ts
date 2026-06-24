import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { OpenClawPluginApi } from "../api.js";
import {
  MALIK_SANDBOX_OPENCLAW_AGENT_ID,
  MALIK_SANDBOX_MAILBOX,
  isSafeSandboxWindowId,
  parseOutlookMessageNotificationResource,
  type AgentWakePostResult,
  type MalikAgentWakeRequest,
  type MalikSandboxFixtureSourceConfig,
  type MalikSandboxGraphWakeDependencies,
  type MalikSandboxGraphWakeState,
  type MalikSandboxGraphWakeWindow,
  type MalikSandboxSourceScope,
  type MentatSandboxWorkflowRunner,
  type MentatSandboxWorkflowRunRequest,
  type MentatSandboxWorkflowRunResult,
  type RestrictedWakeTargetProof,
  type RestrictedWakeTargetValidationRequest,
  type RestrictedWakeTargetValidationResult,
  type RuntimeProfileRef,
  type ScopedMentatSourceRecord,
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
const LEGACY_MALIK_OPENCLAW_AGENT_ID = "malik";
const SAFE_RUNNER_FAILURE_CODES = new Set([
  "invalid_input",
  "host_wake_preflight_failed",
  "runtime_profile_not_sandbox",
  "source_binding_mismatch",
  "workflow_family_mismatch",
  "prohibited_effect_declared",
  "redaction_failed",
  "runtime_error",
  "mentat_runner_not_configured",
  "mentat_runner_timeout",
  "mentat_runner_failed",
  "mentat_runner_output_invalid",
  "runner_result_not_redacted",
  "runner_status_invalid",
]);
const SAFE_RUNNER_HANDLING_STAGES = new Set([
  "completed_no_live_planning",
  "created_waiting_on_approval",
  "blocked_no_matching_workflow",
  "failed_preflight",
]);

const RISKY_TOOL_DENY_COVERAGE: Record<string, { group: string; concrete: string[] }> = {
  outboundSend: { group: "group:messaging", concrete: ["message", "send", "poll"] },
  runtime: { group: "group:runtime", concrete: ["exec", "process", "code_execution"] },
  egress: {
    group: "group:web",
    concrete: ["web_search", "web_fetch", "x_search", "browser", "nodes", "gateway"],
  },
  spawn: { group: "group:sessions", concrete: ["sessions_spawn", "subagents"] },
};

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
  runMentatSandboxWorkflow?: MentatSandboxWorkflowRunner;
  now?: () => Date;
};

type MentatRunnerConfig = {
  command: string;
  args: string[];
  cwd?: string;
  roleBindingId: string;
  engineDataRoot: string;
  rolePackPath: string;
  roleKbPath: string;
  timeoutMs: number;
};

type GraphConfig = {
  bearerTokenRef: unknown;
};

export function createMalikSandboxGraphWakeHostDependencies(
  options: MalikSandboxGraphWakeHostAdapterOptions,
): MalikSandboxGraphWakeDependencies {
  const env = options.env ?? process.env;
  const fetchGraph = options.fetchGraph ?? defaultGraphFetch;
  const runMentatSandboxWorkflow =
    options.runMentatSandboxWorkflow ?? createConfiguredMentatRunner(options.api.pluginConfig);
  return {
    state: options.state,
    now: options.now,
    loadActiveWindow: async () => loadActiveWindow(options.api.pluginConfig),
    validateWakeTarget: async (request) =>
      validateRestrictedWakeTarget({
        config: options.api.config,
        request,
      }),
    fetchScopedSource: async (request) =>
      await fetchScopedGraphSource({
        request,
        api: options.api,
        env,
        fetchGraph,
      }),
    runMentatSandboxWorkflow,
    postAgentWake: async (request) => await scheduleHostWake(options.api, request),
  };
}

async function defaultGraphFetch(url: string, init: FetchInit): Promise<GraphFetchResponse> {
  return await globalThis.fetch(url, init);
}

function createConfiguredMentatRunner(
  pluginConfig: OpenClawPluginApi["pluginConfig"],
): MentatSandboxWorkflowRunner {
  const config = readMentatRunnerConfig(pluginConfig);
  return async (request) => {
    if (!config) {
      return redactedRunnerFailure("mentat_runner_not_configured");
    }
    return await runMentatRunnerSubprocess(config, request);
  };
}

async function runMentatRunnerSubprocess(
  config: MentatRunnerConfig,
  request: MentatSandboxWorkflowRunRequest,
): Promise<MentatSandboxWorkflowRunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-mentat-malik-runner-"));
  const inputFile = join(tempDir, "input.json");
  const outputFile = join(tempDir, "output.json");
  try {
    await writeFile(inputFile, JSON.stringify(buildMentatRunnerInput(config, request)), "utf8");
    const child = spawn(
      config.command,
      [...config.args, "--input", inputFile, "--output", outputFile],
      {
        cwd: config.cwd,
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const exit = await waitForRunner(child, config.timeoutMs);
    if (exit.code !== 0) {
      return redactedRunnerFailure(
        exit.timedOut ? "mentat_runner_timeout" : "mentat_runner_failed",
      );
    }
    const parsed = asRecord(JSON.parse(await readFile(outputFile, "utf8")));
    if (!parsed) {
      return redactedRunnerFailure("mentat_runner_output_invalid");
    }
    return sanitizeMentatRunnerResult(parsed);
  } catch {
    return redactedRunnerFailure("mentat_runner_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildMentatRunnerInput(
  config: MentatRunnerConfig,
  request: MentatSandboxWorkflowRunRequest,
): Record<string, unknown> {
  return {
    roleBindingId: config.roleBindingId,
    engineDataRoot: config.engineDataRoot,
    rolePackPath: config.rolePackPath,
    roleKbPath: config.roleKbPath,
    scopeId: "malik-sandbox-graph-wake",
    workflowFamily: request.workflowFamily,
    runtimeProfile: request.runtimeProfile,
    sourceBinding: request.sourceBinding,
    hostWakeProof: request.hostWakeProof,
    sources: request.sources,
    idempotencyKeyPrefix: request.idempotencyKey,
    now: request.now,
  };
}

function sanitizeMentatRunnerResult(
  value: Record<string, unknown>,
): MentatSandboxWorkflowRunResult {
  const status = readString(value.status);
  const ok = value.ok === true;
  const failureCode = sanitizeRunnerFailureCode(
    readString(asRecord(value.failure)?.code) ?? status,
  );
  const handlingStage = sanitizeRunnerHandlingStage(readString(value.handlingStage));
  const runtime = extractRunnerRuntimeFacts(value.runtime);
  const disabledLiveActions = extractRunnerDisabledLiveActions(value.disabledLiveActions);
  return {
    ok,
    status:
      status === "closed" || status === "open" || status === "blocked" || status === "failed"
        ? status
        : "failed",
    redacted: true,
    ...(value.proofScope === "graph_wake_to_mentat_no_live_workflow"
      ? { proofScope: value.proofScope }
      : {}),
    ...(handlingStage ? { handlingStage } : {}),
    ...(runtime ? { runtime } : {}),
    ...(disabledLiveActions ? { disabledLiveActions } : {}),
    ...(!ok ? { failure: { code: failureCode } } : {}),
  };
}

// Extracts only the three small integer counts from the committed Mentat runner
// shape (runtime.scan.recorded, runtime.loopTick.workflowsCreated/workersDispatched).
// The bridge summarizer re-validates bounds and the workersDispatched===0 gate
// and omits the block on any unsafe value, so this stays a pure shape-map.
function extractRunnerRuntimeFacts(
  value: unknown,
): NonNullable<MentatSandboxWorkflowRunResult["runtime"]> | undefined {
  const runtime = asRecord(value);
  if (!runtime) {
    return undefined;
  }
  const scan = asRecord(runtime.scan);
  const loopTick = asRecord(runtime.loopTick);
  return {
    ...(typeof scan?.recorded === "number" ? { scanRecorded: scan.recorded } : {}),
    ...(typeof loopTick?.workflowsCreated === "number"
      ? { workflowsCreated: loopTick.workflowsCreated }
      : {}),
    ...(typeof loopTick?.workersDispatched === "number"
      ? { workersDispatched: loopTick.workersDispatched }
      : {}),
  };
}

// Extracts only the five disabled-action booleans from the committed runner
// shape. The bridge summarizer requires each to be exactly false and omits the
// block otherwise.
function extractRunnerDisabledLiveActions(
  value: unknown,
): NonNullable<MentatSandboxWorkflowRunResult["disabledLiveActions"]> | undefined {
  const disabled = asRecord(value);
  if (!disabled) {
    return undefined;
  }
  return {
    ...(typeof disabled.emailSend === "boolean" ? { emailSend: disabled.emailSend } : {}),
    ...(typeof disabled.vendorOrCustomerContact === "boolean"
      ? { vendorOrCustomerContact: disabled.vendorOrCustomerContact }
      : {}),
    ...(typeof disabled.netSuiteMutation === "boolean"
      ? { netSuiteMutation: disabled.netSuiteMutation }
      : {}),
    ...(typeof disabled.productionRuntimeOrAccess === "boolean"
      ? { productionRuntimeOrAccess: disabled.productionRuntimeOrAccess }
      : {}),
    ...(typeof disabled.oldRuntimeFallback === "boolean"
      ? { oldRuntimeFallback: disabled.oldRuntimeFallback }
      : {}),
  };
}

function sanitizeRunnerFailureCode(value: string | undefined): string {
  return value && SAFE_RUNNER_FAILURE_CODES.has(value) ? value : "mentat_runner_failed";
}

function sanitizeRunnerHandlingStage(value: string | undefined): string | undefined {
  return value && SAFE_RUNNER_HANDLING_STAGES.has(value) ? value : undefined;
}

function redactedRunnerFailure(code: string): MentatSandboxWorkflowRunResult {
  return {
    ok: false,
    status: "failed",
    redacted: true,
    failure: { code },
  };
}

function waitForRunner(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code: null, timedOut: false });
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, timedOut: false });
    });
  });
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
  const issuedAt = readIssuedAt(activeWindow.issuedAt);
  const windowSeq = readWindowSeq(activeWindow.windowSeq);
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
    issuedAt === undefined ||
    windowSeq === undefined ||
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
    issuedAt,
    windowSeq,
    expiresAt,
    mailbox,
    graphResourcePrefix,
    runtimeProfile,
    netSuiteTarget,
    allowedActions,
    sourceScope,
    sandboxSafeRecipientPlan: readSandboxSafeRecipientPlan(activeWindow.sandboxSafeRecipientPlan),
    sandboxFixtureSource: readSandboxFixtureSource(activeWindow.sandboxFixtureSource),
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
    return { sourceRefs: [], sources: [], blockedReason: "source_outside_approved_scope" };
  }

  const graphConfig = readGraphConfig(params.api.pluginConfig);
  if (!graphConfig || !isSecretRef(graphConfig.bearerTokenRef)) {
    return { sourceRefs: [], sources: [], blockedReason: "host_graph_source_unconfigured" };
  }

  const parsedResource = parseOutlookMessageNotificationResource(
    params.request.notification.resource,
  );
  if (!parsedResource) {
    return { sourceRefs: [], sources: [], blockedReason: "source_outside_approved_scope" };
  }

  const resolvedToken = await resolveConfiguredSecretInputString({
    config: params.api.config,
    env: params.env,
    value: graphConfig.bearerTokenRef,
    path: GRAPH_TOKEN_CONFIG_PATH,
    unresolvedReasonStyle: "generic",
  });
  if (!resolvedToken.value) {
    return { sourceRefs: [], sources: [], blockedReason: "host_graph_source_unconfigured" };
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
      sources: [],
      blockedReason: "host_graph_source_unavailable",
      hostStatus: "graph_fetch_failed",
    };
  }

  const message = asRecord(await response.json());
  if (!message || !messageMatchesSourceScope(message, params.request.sourceScope)) {
    return { sourceRefs: [], sources: [], blockedReason: "source_outside_approved_scope" };
  }

  const messageId = readString(message.id) ?? parsedResource.messageId;
  const sourceRef = buildRedactedSourceRef({ mailbox: params.request.mailbox, messageId });
  return {
    sourceRefs: [sourceRef],
    sources: [
      buildScopedMentatSourceRecord({
        message,
        messageId,
        mailbox: params.request.mailbox,
        sourceRef,
      }),
    ],
  };
}

async function scheduleHostWake(
  api: OpenClawPluginApi,
  request: MalikAgentWakeRequest,
): Promise<AgentWakePostResult> {
  const schedulerAgentId = readDedicatedAgentIdFromSessionKey(request.sessionKey);
  if (schedulerAgentId !== MALIK_SANDBOX_OPENCLAW_AGENT_ID) {
    return { accepted: false, status: "host_scheduler_agent_mismatch" };
  }

  try {
    const wakeId = sha256Hex(request.idempotencyKey).slice(0, 32);
    const result = await api.session.workflow.scheduleSessionTurn({
      sessionKey: request.sessionKey,
      agentId: schedulerAgentId,
      message: buildWakeMessage(request),
      delayMs: 1,
      deleteAfterRun: true,
      deliveryMode: "none",
      name: `malik-sandbox-wake-${wakeId}`,
      tag: "malik-sandbox-wake",
    });
    if (!result?.id) {
      return { accepted: false, status: "host_scheduler_rejected" };
    }
    return { accepted: true, wakeId };
  } catch {
    return { accepted: false, status: "host_scheduler_rejected" };
  }
}

function validateRestrictedWakeTarget(params: {
  config: OpenClawPluginApi["config"];
  request: RestrictedWakeTargetValidationRequest;
}): RestrictedWakeTargetValidationResult {
  const sessionKeyAgentId = readAgentIdFromSessionKey(params.request.sessionKey);
  const agents = asRecord(params.config)?.agents;
  const agentsRecord = asRecord(agents);
  const agentList = Array.isArray(agentsRecord?.list) ? agentsRecord.list : [];
  const dedicatedAgents = findAgentEntries(agentList, MALIK_SANDBOX_OPENCLAW_AGENT_ID);
  const dedicatedAgent = dedicatedAgents.length === 1 ? dedicatedAgents[0] : null;
  const legacyAgent = findAgentEntries(agentList, LEGACY_MALIK_OPENCLAW_AGENT_ID)[0] ?? null;

  const dedicatedWorkspace = readString(dedicatedAgent?.workspace);
  const dedicatedAgentDir = readString(dedicatedAgent?.agentDir);
  const legacyWorkspace = readString(legacyAgent?.workspace);
  const legacyAgentDir = readString(legacyAgent?.agentDir);
  const sandbox = asRecord(dedicatedAgent?.sandbox);
  const tools = asRecord(dedicatedAgent?.tools);
  const fs = asRecord(tools?.fs);
  const deny = readStringArray(tools?.deny);

  const proof: RestrictedWakeTargetProof = {
    agentIdValidated:
      dedicatedAgents.length === 1 &&
      readString(dedicatedAgent?.id) === MALIK_SANDBOX_OPENCLAW_AGENT_ID,
    sessionKeyAgentIdMatchesValidatedAgent:
      sessionKeyAgentId === MALIK_SANDBOX_OPENCLAW_AGENT_ID &&
      params.request.expectedAgentId === MALIK_SANDBOX_OPENCLAW_AGENT_ID,
    agentEntryPresent: dedicatedAgents.length > 0,
    dedicatedAgentId: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
    explicitWorkspace: Boolean(dedicatedWorkspace),
    explicitAgentDir: Boolean(dedicatedAgentDir),
    workspaceDistinctFromMalik: Boolean(
      dedicatedWorkspace && (!legacyWorkspace || dedicatedWorkspace !== legacyWorkspace),
    ),
    agentDirDistinctFromMalik: Boolean(
      dedicatedAgentDir && (!legacyAgentDir || dedicatedAgentDir !== legacyAgentDir),
    ),
    sandboxEnabled: sandbox?.mode === "all" || sandbox?.mode === "non-main",
    workspaceAccessRestricted:
      sandbox?.workspaceAccess === "none" || sandbox?.workspaceAccess === "ro",
    toolsProfileMinimal: tools?.profile === "minimal",
    fsWorkspaceOnly: fs?.workspaceOnly === true,
    riskyCapabilitiesDenied: riskyCapabilitiesDenied(deny),
    rawValuesRedacted: true,
  };

  const ok = Object.entries(proof)
    .filter(([key]) => key !== "dedicatedAgentId" && key !== "rawValuesRedacted")
    .every(([, value]) => value === true);
  if (ok) {
    return { ok: true, proof };
  }
  return {
    ok: false,
    reason: proof.agentEntryPresent
      ? "sandbox_wake_target_not_restricted"
      : "sandbox_wake_target_unavailable",
    proof,
  };
}

function findAgentEntries(list: unknown[], agentId: string): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (readString(record?.id) === agentId) {
      matches.push(record);
    }
  }
  return matches;
}

function readAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim().toLowerCase());
  return match?.[1];
}

function readDedicatedAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const agentId = readAgentIdFromSessionKey(sessionKey);
  return agentId === MALIK_SANDBOX_OPENCLAW_AGENT_ID ? agentId : undefined;
}

function riskyCapabilitiesDenied(deny: string[]): boolean {
  const normalized = new Set(deny.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  return Object.values(RISKY_TOOL_DENY_COVERAGE).every(
    (category) =>
      normalized.has(category.group) ||
      category.concrete.every((candidate) => normalized.has(candidate)),
  );
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
    restrictedWakeTarget: request.payload.restrictedWakeTarget,
    sandboxHandoff: {
      workflowAction: "purchase_orders.create_po",
      graphNotificationAuthority: "wake_only",
      deterministicMentatRunner: request.payload.mentatRunner,
      scheduledTurnRole: "operator_visible_marker_only",
      expectedSideEffects: {
        emailSend: false,
        netSuiteMutation: false,
      },
      vendorNotification: "blocked_without_approved_sandbox_safe_recipient_plan",
      runtimeBoundary: "sandbox_only",
      instructions: [
        "The deterministic Mentat runner has already handled this attempt through Mentat public runtime seams.",
        "This scheduled turn is a non-load-bearing marker; do not run Mentat or replay the workflow from this subagent.",
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

function readMentatRunnerConfig(
  pluginConfig: OpenClawPluginApi["pluginConfig"],
): MentatRunnerConfig | null {
  const runner = asRecord(asRecord(pluginConfig)?.mentatRunner);
  if (!runner) {
    return null;
  }
  const command = readString(runner.command);
  const roleBindingId = readString(runner.roleBindingId);
  const engineDataRoot = readString(runner.engineDataRoot);
  const rolePackPath = readString(runner.rolePackPath);
  const roleKbPath = readString(runner.roleKbPath);
  if (!command || !roleBindingId || !engineDataRoot || !rolePackPath || !roleKbPath) {
    return null;
  }
  const args = readStringArray(runner.args);
  const timeoutMs =
    typeof runner.timeoutMs === "number" && runner.timeoutMs > 0 ? runner.timeoutMs : 30_000;
  return {
    command,
    args,
    cwd: readString(runner.cwd),
    roleBindingId,
    engineDataRoot,
    rolePackPath,
    roleKbPath,
    timeoutMs,
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

// Carries the optional sandbox fixture-source config when the object is PRESENT
// and well-shaped, preserving the raw sourceId/fixtureClass values so the bridge
// resolver can HARD BLOCK (fail closed) on any allowlist mismatch rather than
// silently dropping an invalid override. Returns undefined only when the object
// is genuinely absent or malformed -> default hashed Graph wake source id
// (behavior unchanged). The bridge resolver re-validates every condition.
function readSandboxFixtureSource(value: unknown): MalikSandboxFixtureSourceConfig | undefined {
  const input = asRecord(value);
  if (!input || !("enabled" in input) || typeof input.enabled !== "boolean") {
    return undefined;
  }
  const sourceId = readString(input.sourceId);
  const fixtureClass = readString(input.fixtureClass);
  if (sourceId === undefined || fixtureClass === undefined) {
    return undefined;
  }
  return {
    enabled: input.enabled,
    sourceId,
    fixtureClass,
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

function buildScopedMentatSourceRecord(params: {
  message: Record<string, unknown>;
  messageId: string;
  mailbox: string;
  sourceRef: string;
}): ScopedMentatSourceRecord {
  const sourceHash = sha256Hex(`${params.mailbox}|${params.messageId}`).slice(0, 32);
  const receivedAt = readString(params.message.receivedDateTime) ?? new Date(0).toISOString();
  return {
    id: `graph-wake-source-${sourceHash}`,
    providerId: "email",
    externalId: params.sourceRef,
    sourceType: "email_thread",
    receivedAt,
    subject: readString(params.message.subject) ?? "Redacted sandbox Graph wake source",
    summary:
      "Scoped Microsoft Graph message matched the approved Malik sandbox Graph wake source scope.",
    rawRef: params.sourceRef,
    artifactRefs: [],
    handledStatus: "new",
    metadata: {
      email: {
        provider: "microsoft_graph",
        accountId: params.mailbox,
        threadId: `thread-${sourceHash}`,
        messageIds: [`message-${sourceHash}`],
        receivedAt,
        parentFolderId: "inbox",
        to: [
          {
            name: "Malik sandbox mailbox",
            address: params.mailbox,
          },
        ],
      },
    },
    runtimeProfile: {
      runtimeProfileId: "malik-sandbox-graph-wake",
      environmentClass: "sandbox",
      environmentId: NETSUITE_SANDBOX_ENVIRONMENT_ID,
      sourceProfileId: "malik-mentat-outlook-inbox",
    },
  };
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

// Gate 1: issuedAt must be a present, parseable ISO timestamp. Absent or
// unparseable -> undefined, which fails the whole window to null (mirroring how
// clientStateSha256 invalidation drops the window).
function readIssuedAt(value: unknown): string | undefined {
  const normalized = readString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

// Gate 1: windowSeq must be a present, finite, non-negative integer. Absent or
// any other value -> undefined, which fails the whole window to null.
function readWindowSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const normalized = readString(entry);
    return normalized ? [normalized] : [];
  });
}
