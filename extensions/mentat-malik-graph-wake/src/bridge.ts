import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MALIK_SANDBOX_MAILBOX = "malik-mentat@outlook.com";
export const MALIK_SANDBOX_OPENCLAW_AGENT_ID = "malik-mentat-sandbox";
export const MALIK_SANDBOX_WINDOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NETSUITE_SANDBOX_ENVIRONMENT_ID = "netsuite-sandbox";
const MAX_BODY_BYTES = 64 * 1024;

export type RuntimeProfileRef = {
  environmentClass: "sandbox" | "production";
  environmentId: string;
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

export type MalikSandboxGraphWakeWindow = {
  id: string;
  approved: boolean;
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
  verifyClientState: (clientState: string) => boolean;
};

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

export type ScopedSourceBlockReason =
  | "host_graph_source_unconfigured"
  | "host_graph_source_unavailable"
  | "source_outside_approved_scope";

export type ScopedSourceFetchResult = {
  sourceRefs: string[];
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
  };
};

export type AgentWakePostResult = {
  accepted: boolean;
  wakeId?: string;
  status?: string;
};

export type MalikSandboxGraphWakeState = {
  inFlightScopes: Set<string>;
  completedByIdempotencyKey: Map<string, { wakeId?: string }>;
};

export type MalikSandboxGraphWakeDependencies = {
  state: MalikSandboxGraphWakeState;
  loadActiveWindow: () => Promise<MalikSandboxGraphWakeWindow | null>;
  validateWakeTarget: (
    request: RestrictedWakeTargetValidationRequest,
  ) => Promise<RestrictedWakeTargetValidationResult>;
  fetchScopedSource: (request: ScopedSourceFetchRequest) => Promise<ScopedSourceFetchResult>;
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
  | "mailbox_not_approved"
  | "runtime_profile_not_sandbox"
  | "netsuite_target_not_sandbox"
  | "workflow_action_not_approved"
  | "vendor_notification_recipient_plan_required"
  | "client_state_mismatch"
  | "notification_resource_not_approved"
  | "source_scope_unavailable"
  | "source_scope_empty"
  | "sandbox_wake_target_unavailable"
  | "sandbox_wake_target_not_restricted"
  | ScopedSourceBlockReason
  | "host_poster_rejected";

export function isSafeSandboxWindowId(value: string): boolean {
  return MALIK_SANDBOX_WINDOW_ID_PATTERN.test(value);
}

export function createMalikSandboxGraphWakeState(): MalikSandboxGraphWakeState {
  return {
    inFlightScopes: new Set(),
    completedByIdempotencyKey: new Map(),
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
    if (sourceRefs.length === 0) {
      return blocked("source_scope_empty");
    }

    const wakeRequest = buildWakeRequest({
      activeWindow,
      idempotencyKey,
      notification: redactNotification(parsedNotification),
      restrictedWakeTarget: targetValidation.proof,
      sessionKey,
      sourceRefs,
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
  if (activeWindow.allowedActions.length === 0) {
    return { ok: false, reason: "workflow_action_not_approved" };
  }
  if (
    activeWindow.allowedActions.some(
      (action) => action.family === "purchase_orders" && action.action === "vendor_notification",
    ) &&
    !hasSandboxSafeRecipientPlan(activeWindow.sandboxSafeRecipientPlan)
  ) {
    return { ok: false, reason: "vendor_notification_recipient_plan_required" };
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
  return { ok: true, notification: { ...notification, messageId: parsedResource.messageId } };
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

function buildWakeRequest(params: {
  activeWindow: MalikSandboxGraphWakeWindow;
  idempotencyKey: string;
  notification: GraphNotificationSummary;
  restrictedWakeTarget: RestrictedWakeTargetProof;
  sessionKey: string;
  sourceRefs: string[];
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
