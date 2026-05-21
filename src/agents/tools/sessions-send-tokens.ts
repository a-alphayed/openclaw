import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

export const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
export const REPLY_SKIP_TOKEN = "REPLY_SKIP";

const NON_DELIVERABLE_REPLY_TOKENS = [
  ANNOUNCE_SKIP_TOKEN,
  REPLY_SKIP_TOKEN,
  SILENT_REPLY_TOKEN,
  HEARTBEAT_TOKEN,
] as const;

const NOOP_ANNOUNCE_REPLIES = new Set([
  "no action needed",
  "no action taken",
  "no operational instruction attached no action needed",
  "no operational instruction attached no action taken",
]);

function normalizeSessionsControlText(text?: string) {
  return (text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/[.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAnnounceSkip(text?: string) {
  return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}

export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}

export function isNonDeliverableSessionsReply(text?: string) {
  return NON_DELIVERABLE_REPLY_TOKENS.some((token) => isSilentReplyText(text, token));
}

export function isNonDeliverableSessionsAnnounceReply(text?: string) {
  return (
    isNonDeliverableSessionsReply(text) ||
    NOOP_ANNOUNCE_REPLIES.has(normalizeSessionsControlText(text))
  );
}
