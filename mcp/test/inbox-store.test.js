// mcp/test/inbox-store.test.js — the auto-poller's durable local inbox.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { appendIfNew, takeUnread, unreadCount } = await import("../src/inbox-store.js");

const dir = mkdtempSync(join(tmpdir(), "ct-inbox-"));
const store = join(dir, "nested", "inbox.jsonl"); // nested → exercises mkdir
after(() => rmSync(dir, { recursive: true, force: true }));

const msg = (id, over = {}) => ({ msg_id: id, from: "carl", subject: "s", content: "hi " + id, ...over });

test("appendIfNew stores a new message and is idempotent by id (SQS redelivery safe)", () => {
  assert.equal(appendIfNew(store, msg("m1")), true, "first append is new");
  assert.equal(appendIfNew(store, msg("m1")), false, "same id is a no-op (dedup)");
  assert.equal(appendIfNew(store, msg("m2")), true, "different id is new");
  assert.equal(unreadCount(store), 2);
});

test("takeUnread returns unread oldest-first and marks them read (read-once)", () => {
  const first = takeUnread(store);
  assert.deepEqual(first.map((m) => m.msg_id), ["m1", "m2"], "both unread, oldest first");
  assert.equal(unreadCount(store), 0, "all marked read");
  assert.equal(takeUnread(store).length, 0, "second take is empty (no re-delivery)");
});

test("a message arriving after a read is the only thing returned next", () => {
  assert.equal(appendIfNew(store, msg("m3")), true);
  const next = takeUnread(store);
  assert.deepEqual(next.map((m) => m.msg_id), ["m3"], "only the new one, not the already-read m1/m2");
});

test("limit caps how many unread are taken (rest stay unread)", () => {
  appendIfNew(store, msg("m4"));
  appendIfNew(store, msg("m5"));
  const one = takeUnread(store, 1);
  assert.equal(one.length, 1);
  assert.equal(unreadCount(store), 1, "the other stays unread");
});

test("dedup falls back to message_id / id field names", () => {
  assert.equal(appendIfNew(store, { message_id: "x1", content: "a" }), true);
  assert.equal(appendIfNew(store, { message_id: "x1", content: "a" }), false);
  assert.equal(appendIfNew(store, { id: "y1", content: "b" }), true);
  assert.equal(appendIfNew(store, { id: "y1", content: "b" }), false);
});
