import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MALIK_SANDBOX_MAILBOX = "malik-mentat@outlook.com";
export const MALIK_SANDBOX_OPENCLAW_AGENT_ID = "malik-mentat-sandbox";
export const MALIK_SANDBOX_WINDOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NETSUITE_SANDBOX_ENVIRONMENT_ID = "netsuite-sandbox";
// Sandbox fixture-source proof bridge allowlist. These are hardcoded constants,
// never "any configured value". The override only maps the scanned Mentat source
// id so the existing role-pack fixture resolver creates the no-live
// purchase_orders.create_po workflow; it is deployment/test-window authority, not
// raw source authority.
export const MALIK_SANDBOX_FIXTURE_SOURCE_ID = "source-po-new-millenium-1129895-enriched";
export const MALIK_SANDBOX_FIXTURE_SOURCE_CLASS = "role_pack_sanitized_po_create_fixture";
export const MALIK_SANDBOX_FIXTURE_SOURCE_LABEL = "sandbox_fixture_source_mapping";
// Numeric runner facts are accepted into the redacted summary only within this
// small inclusive bound (defense in depth against arbitrary runner output).
const MAX_SAFE_RUNNER_RUNTIME_COUNT = 16;
// Gate 1 (current-window authority): the bounded validity span. Even an approved
// window with a far-future expiresAt is rejected if expiresAt - issuedAt exceeds
// this, defeating a stale window re-armed with a distant expiry.
const MAX_WINDOW_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
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

export type RuntimeProfileRef = {
  runtimeProfileId?: string;
  environmentClass: "sandbox" | "production";
  environmentId: string;
  sourceProfileId?: string;
};

export type WorkflowActionRef = {
  family: string;
  action: string;
};

export type MalikSandboxSourceScope = {
  selector?: string;
  receivedAfter?: string;
  receivedBefore?: string;
};

// Carries the raw (possibly non-allowlisted) config values so the fail-closed
// resolver can compare against the hardcoded constants and HARD BLOCK on any
// mismatch instead of silently dropping an invalid override. The manifest schema
// already pins sourceId/fixtureClass to consts; this in-code shape is defense in
// depth for a bypassed/drifted schema.
export type MalikSandboxFixtureSourceConfig = {
  enabled: boolean;
  sourceId: string;
  fixtureClass: string;
};

export type MalikSandboxGraphWakeWindow = {
  id: string;
  approved: boolean;
  issuedAt: string;
  windowSeq: number;
  expiresAt: string;
  mailbox: string;
  graphResourcePrefix: string;
  runtimeProfile: RuntimeProfileRef;
  netSuiteTarget: RuntimeProfileRef;
  allowedActions: WorkflowActionRef[];
  sourceScope: MalikSandboxSourceScope;
  sandboxSafeRecipientPlan?: {
    enabled: boolean;
    recipients: string[];
  };
  sandboxFixtureSource?: MalikSandboxFixtureSourceConfig;
  verifyClientState: (clientState: string) => boolean;
};

export type SandboxFixtureSourceMappingEvidence = {
  applied: true;
  sourceAuthority: false;
  fixtureClass: typeof MALIK_SANDBOX_FIXTURE_SOURCE_CLASS;
  sourceId: typeof MALIK_SANDBOX_FIXTURE_SOURCE_ID;
  label: typeof MALIK_SANDBOX_FIXTURE_SOURCE_LABEL;
};

export type SandboxFixtureSourceResolution =
  | {
      applied: true;
      sourceId: typeof MALIK_SANDBOX_FIXTURE_SOURCE_ID;
      evidence: SandboxFixtureSourceMappingEvidence;
    }
  | { applied: false; reason: "absent" | "fail_closed" };

export type GraphNotificationSummary = {
  subscriptionId: string;
  changeType: string;
  resource: string;
};

export type ScopedSourceFetchRequest = {
  sandboxWindowId: string;
  mailbox: string;
  sourceScope: MalikSandboxSourceScope;
  notification: GraphNotificationSummary;
};

export type ScopedMentatSourceRecord = {
  id: string;
  providerId: "email";
  externalId: string;
  sourceType: "email_thread";
  receivedAt: string;
  subject: string;
  summary: string;
  rawRef: string;
  artifactRefs: string[];
  handledStatus: "new";
  metadata: {
    email: {
      provider: "microsoft_graph";
      accountId: string;
      threadId: string;
      messageIds: string[];
      receivedAt: string;
      parentFolderId: "inbox";
      to: Array<{ name: string; address: string }>;
    };
    sandboxFixtureSource?: {
      sourceAuthority: false;
      fixtureClass: typeof MALIK_SANDBOX_FIXTURE_SOURCE_CLASS;
      sourceId: typeof MALIK_SANDBOX_FIXTURE_SOURCE_ID;
      label: typeof MALIK_SANDBOX_FIXTURE_SOURCE_LABEL;
    };
  };
  runtimeProfile: RuntimeProfileRef;
};

export type ScopedSourceBlockReason =
  | "host_graph_source_unconfigured"
  | "host_graph_source_unavailable"
  | "source_outside_approved_scope";

export type ScopedSourceFetchResult = {
  sourceRefs: string[];
  sources: ScopedMentatSourceRecord[];
  blockedReason?: ScopedSourceBlockReason;
  hostStatus?: string;
};

export type RestrictedWakeTargetProof = {
  agentIdValidated: boolean;
  sessionKeyAgentIdMatchesValidatedAgent: boolean;
  agentEntryPresent: boolean;
  dedicatedAgentId: typeof MALIK_SANDBOX_OPENCLAW_AGENT_ID;
  explicitWorkspace: boolean;
  explicitAgentDir: boolean;
  workspaceDistinctFromMalik: boolean;
  agentDirDistinctFromMalik: boolean;
  sandboxEnabled: boolean;
  workspaceAccessRestricted: boolean;
  toolsProfileMinimal: boolean;
  fsWorkspaceOnly: boolean;
  riskyCapabilitiesDenied: boolean;
  rawValuesRedacted: true;
};

export type RestrictedWakeTargetValidationResult =
  | {
      ok: true;
      proof: RestrictedWakeTargetProof;
    }
  | {
      ok: false;
      reason: "sandbox_wake_target_unavailable" | "sandbox_wake_target_not_restricted";
      proof: RestrictedWakeTargetProof;
    };

export type RestrictedWakeTargetValidationRequest = {
  sessionKey: string;
  expectedAgentId: typeof MALIK_SANDBOX_OPENCLAW_AGENT_ID;
};

export type MalikAgentWakeRequest = {
  message: string;
  sessionKey: string;
  wakeMode: "isolated";
  deliver: false;
  idempotencyKey: string;
  payload: {
    bridge: "microsoft_graph_webhook";
    sandboxWindowId: string;
    mailbox: string;
    runtimeProfile: RuntimeProfileRef;
    netSuiteTarget: RuntimeProfileRef;
    workflowActions: WorkflowActionRef[];
    sourceScope: MalikSandboxSourceScope;
    sourceRefs: string[];
    notification: GraphNotificationSummary;
    restrictedWakeTarget: RestrictedWakeTargetProof;
    mentatRunner: MentatRunnerSummary;
    sandboxFixtureSourceMapping?: SandboxFixtureSourceMappingEvidence;
  };
};

export type MentatRunnerRuntimeFacts = {
  scanRecorded: number;
  workflowsCreated: number;
  workersDispatched: number;
};

export type MentatRunnerDisabledLiveActions = {
  emailSend: false;
  vendorOrCustomerContact: false;
  netSuiteMutation: false;
  productionRuntimeOrAccess: false;
  oldRuntimeFallback: false;
};

export type MentatRunnerSummary = {
  status: "closed" | "open" | "blocked";
  proofScope?: "graph_wake_to_mentat_no_live_workflow";
  handlingStage?: string;
  redacted: true;
  runtime?: MentatRunnerRuntimeFacts;
  disabledLiveActions?: MentatRunnerDisabledLiveActions;
};

export type AgentWakePostResult = {
  accepted: boolean;
  wakeId?: string;
  status?: string;
};

export type MentatSandboxWorkflowRunRequest = {
  idempotencyKey: string;
  sandboxWindowId: string;
  workflowFamily: "purchase_orders.create_po";
  runtimeProfile: RuntimeProfileRef;
  sourceBinding: {
    sourceId: "malik-email-inbox";
    mailbox: typeof MALIK_SANDBOX_MAILBOX;
  };
  hostWakeProof: Record<string, unknown>;
  sources: ScopedMentatSourceRecord[];
  sourceRefs: string[];
  notification: GraphNotificationSummary;
  restrictedWakeTarget: RestrictedWakeTargetProof;
  now: string;
};

export type MentatSandboxWorkflowRunResult = {
  ok: boolean;
  status: "closed" | "open" | "blocked" | "failed";
  redacted: true;
  proofScope?: "graph_wake_to_mentat_no_live_workflow";
  handlingStage?: string;
  runtime?: {
    scanRecorded?: number;
    workflowsCreated?: number;
    workersDispatched?: number;
  };
  disabledLiveActions?: {
    emailSend?: boolean;
    vendorOrCustomerContact?: boolean;
    netSuiteMutation?: boolean;
    productionRuntimeOrAccess?: boolean;
    oldRuntimeFallback?: boolean;
  };
  failure?: { code?: string };
};

export type MentatSandboxWorkflowRunner = (
  request: MentatSandboxWorkflowRunRequest,
) => Promise<MentatSandboxWorkflowRunResult>;

export type MalikSandboxGraphWakeState = {
  inFlightScopes: Set<string>;
  completedByIdempotencyKey: Map<string, { wakeId?: string }>;
  // Gate 1 monotonic floor. Initialized to -1 so the first valid window (seq 0+)
  // passes; never decreases. A window whose seq is below this floor is a rollback
  // to a superseded window and is rejected. An EQUAL seq is accepted so one
  // approved window can drive multiple Graph notifications.
  highestWindowSeq: number;
};

export type MalikSandboxGraphWakeDependencies = {
  state: MalikSandboxGraphWakeState;
  loadActiveWindow: () => Promise<MalikSandboxGraphWakeWindow | null>;
  validateWakeTarget: (
    request: RestrictedWakeTargetValidationRequest,
  ) => Promise<RestrictedWakeTargetValidationResult>;
  fetchScopedSource: (request: ScopedSourceFetchRequest) => Promise<ScopedSourceFetchResult>;
  runMentatSandboxWorkflow: MentatSandboxWorkflowRunner;
  postAgentWake: (request: MalikAgentWakeRequest) => Promise<AgentWakePostResult>;
  now?: () => Date;
};

export type GraphWakeHttpRequest = {
  method?: string;
  url?: string;
  body?: string;
};

export type GraphWakeHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Record<string, unknown>;
};

type RawGraphNotification = GraphNotificationSummary & {
  clientState: string;
};

type ParsedGraphNotification = RawGraphNotification & {
  messageId: string;
};

export type OutlookMessageNotificationResource = {
  messageId: string;
};

type BlockReason =
  | "invalid_json"
  | "invalid_graph_notification"
  | "sandbox_window_unavailable"
  | "sandbox_window_id_invalid"
  | "sandbox_window_expired"
  | "sandbox_window_not_current"
  | "mailbox_not_approved"
  | "runtime_profile_not_sandbox"
  | "netsuite_target_not_sandbox"
  | "workflow_action_not_approved"
  | "workflow_action_not_in_window"
  | "vendor_notification_recipient_plan_required"
  | "client_state_mismatch"
  | "notification_resource_not_approved"
  | "source_scope_unavailable"
  | "source_scope_empty"
  | "sandbox_wake_target_unavailable"
  | "sandbox_wake_target_not_restricted"
  | ScopedSourceBlockReason
  | "sandbox_fixture_source_rejected"
  | "mentat_runner_rejected"
  | "host_poster_rejected";

export function isSafeSandboxWindowId(value: string): boolean {
  return MALIK_SANDBOX_WINDOW_ID_PATTERN.test(value);
}

export function createMalikSandboxGraphWakeState(): MalikSandboxGraphWakeState {
  return {
    inFlightScopes: new Set(),
    completedByIdempotencyKey: new Map(),
    highestWindowSeq: -1,
  };
}

export function createMalikSandboxGraphWakeHandler(
  deps: MalikSandboxGraphWakeDependencies,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const response = await handleMalikSandboxGraphWakeRequest(
        {
          method: req.method,
          url: req.url,
          body: await readIncomingRequestBody(req),
        },
        deps,
      );
      writeResponse(res, response);
    })().catch((error: unknown) => {
      writeResponse(res, {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: {
          ok: false,
          status: "blocked",
          reason: "internal_error",
          errorClass: error instanceof Error ? error.name : "unknown_error",
        },
      });
    });
  };
}

export async function handleMalikSandboxGraphWakeRequest(
  request: GraphWakeHttpRequest,
  deps: MalikSandboxGraphWakeDependencies,
): Promise<GraphWakeHttpResponse> {
  const url = new URL(request.url ?? "/", "http://openclaw.local");
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken !== null) {
    return {
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: validationToken,
    };
  }

  if ((request.method ?? "GET").toUpperCase() !== "POST") {
    return jsonResponse(405, {
      ok: false,
      status: "blocked",
      reason: "method_not_allowed",
    });
  }

  const notification = parseGraphNotification(request.body ?? "");
  if (!notification.ok) {
    return jsonResponse(202, {
      ok: false,
      status: "blocked",
      reason: notification.reason,
    });
  }

  const activeWindow = await deps.loadActiveWindow();
  const windowCheck = validateActiveWindow(
    activeWindow,
    notification.value,
    deps.now?.() ?? new Date(),
    deps.state,
  );
  if (!windowCheck.ok) {
    return blocked(windowCheck.reason);
  }
  const parsedNotification = windowCheck.notification;
  const sessionKey = buildSandboxWakeSessionKey(activeWindow.id);
  const targetValidation = await deps.validateWakeTarget({
    sessionKey,
    expectedAgentId: MALIK_SANDBOX_OPENCLAW_AGENT_ID,
  });
  if (!targetValidation.ok) {
    return blocked(targetValidation.reason, {
      restrictedWakeTarget: targetValidation.proof,
    });
  }

  const scopeKey = buildScopeKey(activeWindow);
  const idempotencyKey = buildIdempotencyKey(activeWindow, parsedNotification);
  const previous = deps.state.completedByIdempotencyKey.get(idempotencyKey);
  if (previous) {
    return jsonResponse(202, {
      ok: true,
      status: "duplicate",
      wakeId: previous.wakeId,
      idempotencyKey,
    });
  }
  if (deps.state.inFlightScopes.has(scopeKey)) {
    return jsonResponse(202, {
      ok: true,
      status: "coalesced",
      idempotencyKey,
    });
  }

  deps.state.inFlightScopes.add(scopeKey);
  try {
    const sourceResult = await deps.fetchScopedSource({
      sandboxWindowId: activeWindow.id,
      mailbox: MALIK_SANDBOX_MAILBOX,
      sourceScope: activeWindow.sourceScope,
      notification: redactNotification(parsedNotification),
    });
    if (sourceResult.blockedReason) {
      return blocked(
        sourceResult.blockedReason,
        sourceResult.hostStatus ? { hostStatus: sourceResult.hostStatus } : undefined,
      );
    }

    const sourceRefs = sourceResult.sourceRefs.filter((ref) => ref.trim().length > 0);
    const sources = sourceResult.sources.filter((source) => source.id.trim().length > 0);
    if (sourceRefs.length === 0 || sources.length === 0) {
      return blocked("source_scope_empty");
    }

    // Sandbox fixture-source mapping (fail-closed). Absent -> default hashed id
    // (unchanged). Present-and-valid -> override the scanned source id so the
    // existing Mentat fixture resolver creates the no-live create_po workflow.
    // Present-but-invalid -> hard block, never a silent fallback.
    const fixtureSourceResolution = resolveSandboxFixtureSource(activeWindow);
    if (!fixtureSourceResolution.applied && fixtureSourceResolution.reason === "fail_closed") {
      return blocked("sandbox_fixture_source_rejected");
    }
    const mappedSources = fixtureSourceResolution.applied
      ? sources.map((source) => applySandboxFixtureSourceMapping(source, fixtureSourceResolution))
      : sources;
    const fixtureSourceMappingEvidence = fixtureSourceResolution.applied
      ? fixtureSourceResolution.evidence
      : undefined;

    const redactedNotification = redactNotification(parsedNotification);
    let runnerResult: MentatSandboxWorkflowRunResult;
    try {
      runnerResult = await deps.runMentatSandboxWorkflow(
        buildMentatRunnerRequest({
          activeWindow,
          idempotencyKey,
          notification: redactedNotification,
          restrictedWakeTarget: targetValidation.proof,
          sessionKey,
          sources: mappedSources,
          sourceRefs,
          now: deps.now?.() ?? new Date(),
        }),
      );
    } catch {
      return blocked("mentat_runner_rejected", { hostStatus: "runner_threw" });
    }

    const runnerSummary = summarizeMentatRunnerResult(runnerResult);
    if (!runnerSummary.accepted) {
      return blocked("mentat_runner_rejected", { hostStatus: runnerSummary.hostStatus });
    }

    const wakeRequest = buildWakeRequest({
      activeWindow,
      idempotencyKey,
      notification: redactedNotification,
      restrictedWakeTarget: targetValidation.proof,
      sessionKey,
      sourceRefs,
      mentatRunner: runnerSummary.summary,
      sandboxFixtureSourceMapping: fixtureSourceMappingEvidence,
    });
    const postResult = await deps.postAgentWake(wakeRequest);
    if (!postResult.accepted) {
      return blocked("host_poster_rejected", { hostStatus: postResult.status ?? "rejected" });
    }
    deps.state.completedByIdempotencyKey.set(idempotencyKey, { wakeId: postResult.wakeId });
    return jsonResponse(202, {
      ok: true,
      status: "wake_scheduled",
      wakeId: postResult.wakeId,
      idempotencyKey,
      restrictedWakeTarget: targetValidation.proof,
      mentatRunner: runnerSummary.summary,
      ...(fixtureSourceMappingEvidence
        ? { sandboxFixtureSourceMapping: fixtureSourceMappingEvidence }
        : {}),
    });
  } finally {
    deps.state.inFlightScopes.delete(scopeKey);
  }
}

function parseGraphNotification(
  body: string,
): { ok: true; value: RawGraphNotification } | { ok: false; reason: BlockReason } {
  let parsed: unknown;
  try {
    parsed = body.trim() ? JSON.parse(body) : null;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.value)) {
    return { ok: false, reason: "invalid_graph_notification" };
  }
  for (const entry of parsed.value) {
    if (!isRecord(entry)) {
      continue;
    }
    const subscriptionId = readNonEmptyString(entry.subscriptionId);
    const clientState = readNonEmptyString(entry.clientState);
    const changeType = readNonEmptyString(entry.changeType);
    const resource = readNonEmptyString(entry.resource);
    if (subscriptionId && clientState && changeType && resource) {
      return {
        ok: true,
        value: {
          subscriptionId,
          clientState,
          changeType,
          resource,
        },
      };
    }
  }
  return { ok: false, reason: "invalid_graph_notification" };
}

function validateActiveWindow(
  activeWindow: MalikSandboxGraphWakeWindow | null,
  notification: RawGraphNotification,
  now: Date,
  state: MalikSandboxGraphWakeState,
): { ok: true; notification: ParsedGraphNotification } | { ok: false; reason: BlockReason } {
  if (!activeWindow || !activeWindow.approved) {
    return { ok: false, reason: "sandbox_window_unavailable" };
  }
  if (!isSafeSandboxWindowId(activeWindow.id)) {
    return { ok: false, reason: "sandbox_window_id_invalid" };
  }
  const expiresAt = Date.parse(activeWindow.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, reason: "sandbox_window_expired" };
  }
  // Gate 1: current-window authority. Reject a future-dated, over-long, or
  // superseded (rolled-back) window even when approved + not yet expired. An
  // equal seq is accepted (multi-notification); only a LOWER seq is a rollback.
  const currency = checkWindowCurrency(activeWindow, now, state.highestWindowSeq);
  if (!currency.ok) {
    return { ok: false, reason: currency.reason };
  }
  if (activeWindow.mailbox.toLowerCase() !== MALIK_SANDBOX_MAILBOX) {
    return { ok: false, reason: "mailbox_not_approved" };
  }
  if (
    activeWindow.runtimeProfile.environmentClass !== "sandbox" ||
    activeWindow.runtimeProfile.environmentId !== NETSUITE_SANDBOX_ENVIRONMENT_ID
  ) {
    return { ok: false, reason: "runtime_profile_not_sandbox" };
  }
  if (
    activeWindow.netSuiteTarget.environmentClass !== "sandbox" ||
    activeWindow.netSuiteTarget.environmentId !== NETSUITE_SANDBOX_ENVIRONMENT_ID
  ) {
    return { ok: false, reason: "netsuite_target_not_sandbox" };
  }
  // Gate 2: first-class family/action classification against the allowlist.
  const actionClassification = classifyWindowWorkflowActions(activeWindow);
  if (!actionClassification.ok) {
    return { ok: false, reason: actionClassification.reason };
  }
  if (!activeWindow.verifyClientState(notification.clientState)) {
    return { ok: false, reason: "client_state_mismatch" };
  }

  // graphResourcePrefix is the approved subscription scope, not a byte-prefix
  // assertion against Graph's delivered changed-resource path.
  if (!activeWindow.graphResourcePrefix) {
    return { ok: false, reason: "notification_resource_not_approved" };
  }
  const parsedResource = parseOutlookMessageNotificationResource(notification.resource);
  if (!parsedResource) {
    return { ok: false, reason: "notification_resource_not_approved" };
  }
  if (!hasApprovedSourceScope(activeWindow.sourceScope)) {
    return { ok: false, reason: "source_scope_unavailable" };
  }
  // Advance the monotonic floor only after the ENTIRE window validation
  // succeeds, so a window rejected by a later check cannot raise the floor and
  // lock out a subsequent legitimate (equal/lower) seq. The currency comparison
  // above still reads the unmutated floor; only the recording happens here.
  state.highestWindowSeq = Math.max(state.highestWindowSeq, activeWindow.windowSeq);
  return { ok: true, notification: { ...notification, messageId: parsedResource.messageId } };
}

// Gate 1 (current-window authority) currency check. Pure: compares the window's
// issuedAt/windowSeq/expiresAt against `now` and the monotonic floor without
// mutating state. The caller records the seq on a pass. Fails closed unless ALL
// hold: issuedAt parses and is not future-dated; expiresAt - issuedAt is within
// the bounded lifetime; windowSeq is >= the highest seq already seen (equal seq
// accepted; a lower seq is a rollback to a superseded window and is rejected).
export function checkWindowCurrency(
  activeWindow: Pick<MalikSandboxGraphWakeWindow, "issuedAt" | "expiresAt" | "windowSeq">,
  now: Date,
  highestWindowSeq: number,
): { ok: true } | { ok: false; reason: "sandbox_window_not_current" } {
  const issuedAt = Date.parse(activeWindow.issuedAt);
  const expiresAt = Date.parse(activeWindow.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "sandbox_window_not_current" };
  }
  // issuedAt must not be in the future.
  if (issuedAt > now.getTime()) {
    return { ok: false, reason: "sandbox_window_not_current" };
  }
  // Bounded validity span defeats a far-future expiresAt re-armed onto a stale
  // window.
  if (expiresAt - issuedAt > MAX_WINDOW_LIFETIME_MS) {
    return { ok: false, reason: "sandbox_window_not_current" };
  }
  // Monotonic rule: reject a rollback to a superseded (lower seq) window; an
  // equal seq is accepted so one window can drive multiple notifications.
  if (
    !Number.isInteger(activeWindow.windowSeq) ||
    activeWindow.windowSeq < 0 ||
    activeWindow.windowSeq < highestWindowSeq
  ) {
    return { ok: false, reason: "sandbox_window_not_current" };
  }
  return { ok: true };
}

export type WorkflowActionClassification = "allowed" | "vendor_needs_plan" | "unlisted";

// Gate 2 (pre-scan family/action classification). Pure: classifies a single
// requested action against the allowlist. `create_po` in the purchase_orders
// family is first-class allowed; `vendor_notification` is listed but needs an
// approved sandbox-safe recipient plan; anything else is unlisted (off-scope).
// This is defense-in-depth: the manifest pins allowedActions to create_po, so
// the non-allowed branches are schema-unreachable in the full flow but stay
// unit-testable and ready for future workflow families.
export function classifyWorkflowAction(action: WorkflowActionRef): WorkflowActionClassification {
  if (action.family === "purchase_orders" && action.action === "create_po") {
    return "allowed";
  }
  if (action.family === "purchase_orders" && action.action === "vendor_notification") {
    return "vendor_needs_plan";
  }
  return "unlisted";
}

// Classifies the whole window's requested action set, emitting the first
// off-scope outcome as a distinct block reason. Empty action sets stay reported
// as `workflow_action_not_approved` (unchanged). Any unlisted action blocks with
// the new `workflow_action_not_in_window`; a vendor_notification action without
// a sandbox-safe recipient plan reuses `vendor_notification_recipient_plan_required`.
function classifyWindowWorkflowActions(activeWindow: MalikSandboxGraphWakeWindow):
  | { ok: true }
  | {
      ok: false;
      reason:
        | "workflow_action_not_approved"
        | "workflow_action_not_in_window"
        | "vendor_notification_recipient_plan_required";
    } {
  if (activeWindow.allowedActions.length === 0) {
    return { ok: false, reason: "workflow_action_not_approved" };
  }
  const classifications = activeWindow.allowedActions.map(classifyWorkflowAction);
  if (classifications.includes("unlisted")) {
    return { ok: false, reason: "workflow_action_not_in_window" };
  }
  if (
    classifications.includes("vendor_needs_plan") &&
    !hasSandboxSafeRecipientPlan(activeWindow.sandboxSafeRecipientPlan)
  ) {
    return { ok: false, reason: "vendor_notification_recipient_plan_required" };
  }
  return { ok: true };
}

function hasSandboxSafeRecipientPlan(
  plan: MalikSandboxGraphWakeWindow["sandboxSafeRecipientPlan"],
): boolean {
  return plan?.enabled === true && plan.recipients.some((recipient) => recipient.trim().length > 0);
}

function hasApprovedSourceScope(sourceScope: MalikSandboxSourceScope): boolean {
  const hasSelector = Boolean(sourceScope.selector?.trim());
  const hasReceivedAfter = Boolean(sourceScope.receivedAfter?.trim());
  const hasReceivedBefore = Boolean(sourceScope.receivedBefore?.trim());
  if (hasReceivedAfter || hasReceivedBefore) {
    if (!sourceScope.receivedAfter || !sourceScope.receivedBefore) {
      return false;
    }

    const receivedAfter = Date.parse(sourceScope.receivedAfter);
    const receivedBefore = Date.parse(sourceScope.receivedBefore);
    if (!Number.isFinite(receivedAfter) || !Number.isFinite(receivedBefore)) {
      return false;
    }
    return receivedAfter < receivedBefore;
  }

  return hasSelector;
}

// Pure, fail-closed sandbox fixture-source resolution. Returns an override only
// when EVERY allowlist condition holds. When the optional config is absent the
// default hashed Graph wake source id is preserved (behavior unchanged). When
// the config is present but any condition fails, the request is blocked (the
// caller treats `fail_closed` as a hard block, never a silent fallback). All
// constants are re-validated here even though the manifest schema already pins
// them, as defense in depth against a manifest/runtime drift or a bypassed
// schema. This object is deployment/test-window authority, not source authority.
export function resolveSandboxFixtureSource(
  activeWindow: MalikSandboxGraphWakeWindow,
): SandboxFixtureSourceResolution {
  const fixtureSource = activeWindow.sandboxFixtureSource;
  if (fixtureSource === undefined) {
    return { applied: false, reason: "absent" };
  }

  const allowed =
    fixtureSource.enabled === true &&
    fixtureSource.sourceId === MALIK_SANDBOX_FIXTURE_SOURCE_ID &&
    fixtureSource.fixtureClass === MALIK_SANDBOX_FIXTURE_SOURCE_CLASS &&
    // Exactly one allowed action and it must be purchase_orders.create_po.
    activeWindow.allowedActions.length === 1 &&
    activeWindow.allowedActions[0]?.family === "purchase_orders" &&
    activeWindow.allowedActions[0]?.action === "create_po" &&
    // Runtime profile and NetSuite target must both be the sandbox target.
    activeWindow.runtimeProfile.environmentClass === "sandbox" &&
    activeWindow.runtimeProfile.environmentId === NETSUITE_SANDBOX_ENVIRONMENT_ID &&
    activeWindow.netSuiteTarget.environmentClass === "sandbox" &&
    activeWindow.netSuiteTarget.environmentId === NETSUITE_SANDBOX_ENVIRONMENT_ID &&
    // Mailbox must be exactly the approved sandbox mailbox.
    activeWindow.mailbox.toLowerCase() === MALIK_SANDBOX_MAILBOX &&
    // Vendor notification must stay blocked: no sandbox-safe recipient plan is
    // enabled for this proof path.
    !hasSandboxSafeRecipientPlan(activeWindow.sandboxSafeRecipientPlan);

  if (!allowed) {
    return { applied: false, reason: "fail_closed" };
  }

  return {
    applied: true,
    sourceId: MALIK_SANDBOX_FIXTURE_SOURCE_ID,
    evidence: {
      applied: true,
      sourceAuthority: false,
      fixtureClass: MALIK_SANDBOX_FIXTURE_SOURCE_CLASS,
      sourceId: MALIK_SANDBOX_FIXTURE_SOURCE_ID,
      label: MALIK_SANDBOX_FIXTURE_SOURCE_LABEL,
    },
  };
}

// Maps the scanned source record onto the allowlisted fixture source id so the
// existing Mentat fixture resolver creates the no-live create_po workflow. Only
// `id`, `summary`, and the added `metadata.sandboxFixtureSource` evidence block
// change; redacted hashed externalId/rawRef/thread/message refs derived from the
// real Graph message are preserved unchanged. No raw body/header/url/path/token
// is introduced.
function applySandboxFixtureSourceMapping(
  source: ScopedMentatSourceRecord,
  resolution: Extract<SandboxFixtureSourceResolution, { applied: true }>,
): ScopedMentatSourceRecord {
  return {
    ...source,
    id: resolution.sourceId,
    summary:
      "Approved sandbox fixture-source proof bridge. Source id mapped to a role-pack " +
      "sanitized PO-create fixture for no-live workflow planning. This is " +
      "deployment/test-window authority, not raw source authority.",
    metadata: {
      ...source.metadata,
      sandboxFixtureSource: {
        sourceAuthority: false,
        fixtureClass: resolution.evidence.fixtureClass,
        sourceId: resolution.sourceId,
        label: resolution.evidence.label,
      },
    },
  };
}

function buildMentatRunnerRequest(params: {
  activeWindow: MalikSandboxGraphWakeWindow;
  idempotencyKey: string;
  notification: GraphNotificationSummary;
  restrictedWakeTarget: RestrictedWakeTargetProof;
  sessionKey: string;
  sourceRefs: string[];
  sources: ScopedMentatSourceRecord[];
  now: Date;
}): MentatSandboxWorkflowRunRequest {
  const runtimeProfile = mentatSandboxRuntimeProfile(params.activeWindow.runtimeProfile);
  return {
    idempotencyKey: params.idempotencyKey,
    sandboxWindowId: params.activeWindow.id,
    workflowFamily: "purchase_orders.create_po",
    runtimeProfile,
    sourceBinding: {
      sourceId: "malik-email-inbox",
      mailbox: MALIK_SANDBOX_MAILBOX,
    },
    hostWakeProof: buildRedactedHostWakeProof({
      activeWindow: params.activeWindow,
      restrictedWakeTarget: params.restrictedWakeTarget,
      sessionKey: params.sessionKey,
    }),
    sources: params.sources.map((source) => ({ ...source, runtimeProfile })),
    sourceRefs: [...params.sourceRefs],
    notification: params.notification,
    restrictedWakeTarget: params.restrictedWakeTarget,
    now: params.now.toISOString(),
  };
}

function buildRedactedHostWakeProof(params: {
  activeWindow: MalikSandboxGraphWakeWindow;
  restrictedWakeTarget: RestrictedWakeTargetProof;
  sessionKey: string;
}): Record<string, unknown> {
  return {
    proofMode: "host_redacted_sandbox_graph_wake",
    workflowFamily: "purchase_orders.create_po",
    proofScope: "wake_scheduled_only",
    sandboxGraphWakeProofStatus: "open",
    evidenceSource: {
      sourceClass: "host_deployment_submitted_redacted",
      hostOwned: true,
      localFixture: false,
      templateOnly: false,
    },
    hostBindings: {
      sourceBinding: {
        sourceId: "malik-email-inbox",
        mailbox: MALIK_SANDBOX_MAILBOX,
        observedMailbox: MALIK_SANDBOX_MAILBOX,
        mailboxIdentityHostAttested: true,
        redacted: true,
      },
      runtimeProfile: {
        runtimeProfileRequirement: "sandbox_only",
        targetClass: "sandbox",
        mutationAttempted: false,
        productionAccess: false,
        redacted: true,
      },
      wakeRouteBinding: {
        sessionTarget: params.sessionKey,
        targetClass: "restricted_subagent_lane",
        wakeScheduledStatus: "wake_scheduled",
        sandboxLaneClass: "mentat_sandbox",
        safeWindowId: params.activeWindow.id,
        singleFlight: true,
        redacted: true,
      },
    },
    proofPacket: {
      redacted: true,
      containsSourceAuthority: false,
      containsEmailSend: false,
      containsVendorOrCustomerContact: false,
      containsExternalMutation: false,
      containsProductionRuntime: false,
      containsOldRuntimeFallback: false,
      containsLiveNetSuiteMutation: false,
      containsProductionNetSuiteAccess: false,
      containsRawIds: false,
      containsMessageBodiesOrHeaders: false,
      containsUrls: false,
      containsLocalPaths: false,
      containsTokensOrSecrets: false,
      containsLogs: false,
      containsNetSuiteAccountOrRoleValues: false,
      containsOldWorkspaceFields: false,
    },
    confirmations: {
      noWorkflowExecutionProof: true,
      noEmailSendProof: true,
      noNetSuiteMutationProof: true,
      noProductionReadinessClaim: true,
      exactDedicatedAgentHostAttestedOnly: true,
      primaryAgentDerivedFromRolePackIdPolicy: true,
    },
    redactedDiagnostics: true,
  };
}

function summarizeMentatRunnerResult(result: MentatSandboxWorkflowRunResult):
  | {
      accepted: true;
      summary: MalikAgentWakeRequest["payload"]["mentatRunner"];
    }
  | { accepted: false; hostStatus: string } {
  if (result.redacted !== true) {
    return { accepted: false, hostStatus: "runner_result_not_redacted" };
  }
  if (result.ok !== true) {
    return {
      accepted: false,
      hostStatus: sanitizeRunnerFailureCode(result.failure?.code ?? result.status),
    };
  }
  if (result.status !== "open" && result.status !== "blocked" && result.status !== "closed") {
    return { accepted: false, hostStatus: "runner_status_invalid" };
  }
  const handlingStage = sanitizeRunnerHandlingStage(result.handlingStage);
  const runtime = sanitizeRunnerRuntimeFacts(result.runtime);
  const disabledLiveActions = sanitizeRunnerDisabledLiveActions(result.disabledLiveActions);
  return {
    accepted: true,
    summary: {
      status: result.status,
      proofScope: result.proofScope,
      ...(handlingStage ? { handlingStage } : {}),
      redacted: true,
      ...(runtime ? { runtime } : {}),
      ...(disabledLiveActions ? { disabledLiveActions } : {}),
    },
  };
}

// Whitelist only the three small non-negative integer runtime facts. The first
// host proof must stop at no worker dispatch, so workersDispatched must be 0.
// Any missing / non-finite / negative / out-of-bounds value omits the block.
function sanitizeRunnerRuntimeFacts(
  runtime: MentatSandboxWorkflowRunResult["runtime"],
): MentatRunnerRuntimeFacts | undefined {
  if (!runtime) {
    return undefined;
  }
  const scanRecorded = runtime.scanRecorded;
  const workflowsCreated = runtime.workflowsCreated;
  const workersDispatched = runtime.workersDispatched;
  if (
    !isSafeRuntimeCount(scanRecorded) ||
    !isSafeRuntimeCount(workflowsCreated) ||
    !isSafeRuntimeCount(workersDispatched) ||
    workersDispatched !== 0
  ) {
    return undefined;
  }
  return { scanRecorded, workflowsCreated, workersDispatched };
}

function isSafeRuntimeCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE_RUNNER_RUNTIME_COUNT
  );
}

// Whitelist only the five disabled-action booleans and require each to be
// exactly false. Any missing or non-false value omits the block.
function sanitizeRunnerDisabledLiveActions(
  disabledLiveActions: MentatSandboxWorkflowRunResult["disabledLiveActions"],
): MentatRunnerDisabledLiveActions | undefined {
  if (!disabledLiveActions) {
    return undefined;
  }
  if (
    disabledLiveActions.emailSend !== false ||
    disabledLiveActions.vendorOrCustomerContact !== false ||
    disabledLiveActions.netSuiteMutation !== false ||
    disabledLiveActions.productionRuntimeOrAccess !== false ||
    disabledLiveActions.oldRuntimeFallback !== false
  ) {
    return undefined;
  }
  return {
    emailSend: false,
    vendorOrCustomerContact: false,
    netSuiteMutation: false,
    productionRuntimeOrAccess: false,
    oldRuntimeFallback: false,
  };
}

function sanitizeRunnerFailureCode(value: string | undefined): string {
  return value && SAFE_RUNNER_FAILURE_CODES.has(value) ? value : "mentat_runner_failed";
}

function sanitizeRunnerHandlingStage(value: string | undefined): string | undefined {
  return value && SAFE_RUNNER_HANDLING_STAGES.has(value) ? value : undefined;
}

function mentatSandboxRuntimeProfile(runtimeProfile: RuntimeProfileRef): RuntimeProfileRef {
  return {
    runtimeProfileId: "malik-sandbox-graph-wake",
    environmentClass: runtimeProfile.environmentClass,
    environmentId: runtimeProfile.environmentId,
    sourceProfileId: "malik-mentat-outlook-inbox",
  };
}

function buildWakeRequest(params: {
  activeWindow: MalikSandboxGraphWakeWindow;
  idempotencyKey: string;
  notification: GraphNotificationSummary;
  restrictedWakeTarget: RestrictedWakeTargetProof;
  sessionKey: string;
  sourceRefs: string[];
  mentatRunner: MalikAgentWakeRequest["payload"]["mentatRunner"];
  sandboxFixtureSourceMapping?: SandboxFixtureSourceMappingEvidence;
}): MalikAgentWakeRequest {
  return {
    message: "Mentat Malik sandbox Graph webhook wake",
    sessionKey: params.sessionKey,
    wakeMode: "isolated",
    deliver: false,
    idempotencyKey: params.idempotencyKey,
    payload: {
      bridge: "microsoft_graph_webhook",
      sandboxWindowId: params.activeWindow.id,
      mailbox: MALIK_SANDBOX_MAILBOX,
      runtimeProfile: params.activeWindow.runtimeProfile,
      netSuiteTarget: params.activeWindow.netSuiteTarget,
      workflowActions: params.activeWindow.allowedActions.map((action) => ({ ...action })),
      sourceScope: { ...params.activeWindow.sourceScope },
      sourceRefs: [...params.sourceRefs],
      notification: params.notification,
      restrictedWakeTarget: params.restrictedWakeTarget,
      mentatRunner: params.mentatRunner,
      ...(params.sandboxFixtureSourceMapping
        ? { sandboxFixtureSourceMapping: params.sandboxFixtureSourceMapping }
        : {}),
    },
  };
}

export function buildSandboxWakeSessionKey(windowId: string): string {
  return `agent:${MALIK_SANDBOX_OPENCLAW_AGENT_ID}:subagent:mentat-sandbox-${windowId}`;
}

function buildScopeKey(activeWindow: MalikSandboxGraphWakeWindow): string {
  return [
    activeWindow.id,
    MALIK_SANDBOX_MAILBOX,
    activeWindow.runtimeProfile.environmentClass,
    activeWindow.runtimeProfile.environmentId,
    activeWindow.allowedActions
      .map((action) => `${action.family}.${action.action}`)
      .sort()
      .join(","),
  ].join("|");
}

function buildIdempotencyKey(
  activeWindow: MalikSandboxGraphWakeWindow,
  notification: ParsedGraphNotification,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        windowId: activeWindow.id,
        mailbox: MALIK_SANDBOX_MAILBOX,
        subscriptionId: notification.subscriptionId,
        messageId: notification.messageId,
        changeType: notification.changeType,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `malik-sandbox-graph-wake:${digest}`;
}

function redactNotification(notification: ParsedGraphNotification): GraphNotificationSummary {
  return {
    subscriptionId: notification.subscriptionId,
    changeType: notification.changeType,
    resource: notification.resource,
  };
}

function blocked(reason: BlockReason, extra?: Record<string, unknown>): GraphWakeHttpResponse {
  return jsonResponse(202, {
    ok: false,
    status: "blocked",
    reason,
    ...extra,
  });
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): GraphWakeHttpResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body,
  };
}

function writeResponse(res: ServerResponse, response: GraphWakeHttpResponse): void {
  res.writeHead(response.statusCode, response.headers);
  if (typeof response.body === "string") {
    res.end(response.body);
    return;
  }
  res.end(JSON.stringify(response.body));
}

async function readIncomingRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request_body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseOutlookMessageNotificationResource(
  resource: string,
): OutlookMessageNotificationResource | null {
  const normalized = normalizeGraphNotificationResource(resource);
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.length === 4) {
    const [usersSegment, userSegment, messagesSegment, messageIdSegment] = segments;
    if (
      matchesGraphFixedSegment(usersSegment, "users") &&
      userSegment &&
      matchesGraphFixedSegment(messagesSegment, "messages")
    ) {
      return parseMessageIdSegment(messageIdSegment);
    }
    return null;
  }

  if (segments.length === 6) {
    const [
      usersSegment,
      mailboxSegment,
      mailFoldersSegment,
      folderSegment,
      messagesSegment,
      messageIdSegment,
    ] = segments;
    if (
      matchesGraphFixedSegment(usersSegment, "users") &&
      mailboxSegment.toLowerCase() === MALIK_SANDBOX_MAILBOX &&
      matchesGraphFixedSegment(mailFoldersSegment, "mailFolders") &&
      matchesGraphFixedSegment(folderSegment, "inbox") &&
      matchesGraphFixedSegment(messagesSegment, "messages")
    ) {
      return parseMessageIdSegment(messageIdSegment);
    }
  }

  return null;
}

function normalizeGraphNotificationResource(resource: string): string | null {
  const trimmed = resource.trim();
  if (!trimmed || trimmed.includes("?") || trimmed.endsWith("/")) {
    return null;
  }
  const normalized = trimmed.replace(/^\/+/, "");
  return normalized && !normalized.includes("//") ? normalized : null;
}

function matchesGraphFixedSegment(value: string, expected: string): boolean {
  return value.toLowerCase() === expected.toLowerCase();
}

function parseMessageIdSegment(value: string): OutlookMessageNotificationResource | null {
  if (!value) {
    return null;
  }
  try {
    const messageId = decodeURIComponent(value);
    return messageId.trim() ? { messageId } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
