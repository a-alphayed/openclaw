/**
 * message-log.ts — Lightweight SQLite logger for ACP session messages.
 *
 * Captures inbound (user) and outbound (assistant) messages that flow through
 * ACP sessions, so that new Claude Code sessions can recall prior conversations.
 *
 * Fire-and-forget: logging failures never block the message pipeline.
 * DB location: ~/.openclaw/acp-messages.db
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = join(homedir(), ".openclaw", "acp-messages.db");

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync | null {
  if (db) {
    return db;
  }
  try {
    mkdirSync(join(homedir(), ".openclaw"), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
        session_key TEXT NOT NULL,
        direction   TEXT NOT NULL,
        channel     TEXT,
        chat_id     TEXT,
        topic_id    TEXT,
        sender_id   TEXT,
        sender_name TEXT,
        body        TEXT,
        message_sid TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_msg_topic ON messages(topic_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_key)");
    return db;
  } catch {
    // Non-fatal: if DB init fails, silently skip logging.
    return null;
  }
}

export function logAcpMessage(params: {
  sessionKey: string;
  direction: "inbound" | "outbound";
  channel?: string;
  chatId?: string;
  topicId?: string;
  senderId?: string;
  senderName?: string;
  body?: string;
  messageSid?: string;
}): void {
  try {
    const database = getDb();
    if (!database) {
      return;
    }
    database
      .prepare(
        `INSERT INTO messages (id, session_key, direction, channel, chat_id, topic_id, sender_id, sender_name, body, message_sid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        params.sessionKey,
        params.direction,
        params.channel ?? null,
        params.chatId ?? null,
        params.topicId ?? null,
        params.senderId ?? null,
        params.senderName ?? null,
        params.body ?? null,
        params.messageSid ?? null,
      );
  } catch {
    // Fire-and-forget: never block the message pipeline.
  }
}
