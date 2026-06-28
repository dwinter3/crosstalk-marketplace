// mcp/src/inbox-store.js — durable local inbox for the auto-poller (the marketplace daemon-equivalent).
//
// The auto-poller is the SOLE SQS reader. For each arrival it appends HERE (durable, 0600) BEFORE
// deleting from SQS, so a message is never lost even if the `notifications/claude/channel` push
// doesn't surface (e.g. the session has channels disabled). `check_inbox` then reads UNREAD entries
// from here and marks them read. This mirrors our crosstalk daemon's SQS→local-store→push split.
//
// Format: one JSON object per line (the parsed crosstalk envelope) + `_read` / `_stored_at` markers.
// Dedup is by message id (msg_id|message_id|id) so an SQS redelivery (delete failed) won't double-store.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const idOf = (m) => m && (m.msg_id || m.message_id || m.id) || null;

// Compaction bound (#2): on each rewrite, keep ALL unread + only the most-recent READ rows (retained
// purely as dedup history vs SQS redelivery). Bounds inbox.jsonl growth without losing anything live.
const MAX_READ_HISTORY = 200;

function readAll(storePath) {
  if (!existsSync(storePath)) return [];
  return readFileSync(storePath, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Append `msg` unless its id is already stored. Returns true iff newly appended. */
export function appendIfNew(storePath, msg) {
  mkdirSync(dirname(storePath), { recursive: true });
  const id = idOf(msg);
  if (id && readAll(storePath).some((m) => idOf(m) === id)) return false;
  const row = { ...msg, _read: false, _stored_at: new Date().toISOString() };
  appendFileSync(storePath, JSON.stringify(row) + "\n", { mode: 0o600 });
  return true;
}

/** Return unread messages (oldest first) AND mark them read (rewrite the file). */
export function takeUnread(storePath, limit = 50) {
  const all = readAll(storePath);
  const unread = all.filter((m) => !m._read).slice(0, limit);
  if (unread.length) {
    const taken = new Set(unread.map((m) => idOf(m)));
    const updated = all.map((m) => (taken.has(idOf(m)) ? { ...m, _read: true } : m));
    // Compaction (#2): keep every unread row + the most-recent MAX_READ_HISTORY read rows (preserve order).
    const keepRead = new Set(updated.filter((m) => m._read).slice(-MAX_READ_HISTORY).map((m) => idOf(m)));
    const compacted = updated.filter((m) => !m._read || keepRead.has(idOf(m)));
    writeFileSync(storePath, compacted.map((m) => JSON.stringify(m)).join("\n") + "\n", { mode: 0o600 });
  }
  return unread;
}

/** Count of unread (for a startup/idle hint). */
export function unreadCount(storePath) {
  return readAll(storePath).filter((m) => !m._read).length;
}
