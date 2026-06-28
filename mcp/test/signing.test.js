// mcp/test/signing.test.js — #1179 client-signing. Proves the client signs the SAME canonical the
// receiver verifies, the key persists, and a tampered canonical fails — without any AWS/network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadOrCreateIdentity, signCanonical } = await import("../src/identity.js");
const { canonicalEnvelope } = await import("../src/canonical-envelope.js");

const dir = mkdtempSync(join(tmpdir(), "ct-signing-"));
const store = join(dir, "nested", "identity.pem"); // nested → exercises mkdir
after(() => rmSync(dir, { recursive: true, force: true }));

// A receiver re-derives the public key from the advertised SPKI-b64 and verifies over canonicalEnvelope.
function receiverVerify(pubkeyB64, canonical, sigB64) {
  const pub = crypto.createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(canonicalEnvelope(canonical), "utf8"), pub, Buffer.from(sigB64, "base64"));
}

test("first run mints an ed25519 identity; sig verifies against the advertised pubkey over canonicalEnvelope", () => {
  const id = loadOrCreateIdentity(store);
  assert.match(id.pubkeyB64, /^[A-Za-z0-9+/=]+$/);
  assert.equal(id.fingerprint.length, 64); // sha256 hex
  const canonical = { msg_id: "m1", from: "whoscarmen742-coder2", to: "claude-mux-prime", subject: "s", content: "hi", ts: "2026-06-28T16:00:00.000Z" };
  const sig = signCanonical(id.privateKey, canonical);
  assert.equal(receiverVerify(id.pubkeyB64, canonical, sig), true, "receiver verifies the client's sig over the shared canonical");
});

test("a tampered canonical fails verification (the signature binds every canonical field)", () => {
  const id = loadOrCreateIdentity(store);
  const canonical = { msg_id: "m2", from: "whoscarmen742-coder2", to: "claude-mux-prime", subject: "", content: "original", ts: "2026-06-28T16:00:00.000Z" };
  const sig = signCanonical(id.privateKey, canonical);
  assert.equal(receiverVerify(id.pubkeyB64, { ...canonical, content: "tampered" }, sig), false);
  assert.equal(receiverVerify(id.pubkeyB64, { ...canonical, from: "someone-else" }, sig), false);
});

test("identity persists across loads (same pubkey/fingerprint — a stable pinnable identity)", () => {
  const a = loadOrCreateIdentity(store);
  const b = loadOrCreateIdentity(store);
  assert.equal(a.pubkeyB64, b.pubkeyB64);
  assert.equal(a.fingerprint, b.fingerprint);
});

test("absent optional fields (thread_id/ts) coerce to '' on both sides — verifies (the #1229 invariant)", () => {
  const id = loadOrCreateIdentity(store);
  const minimal = { msg_id: "m3", from: "whoscarmen742-coder2", to: "claude-mux-prime", subject: "", content: "no ts no thread" };
  const sig = signCanonical(id.privateKey, minimal); // signs with ts/thread_id absent → ''
  // receiver rebuilds the same canonical from as-received fields (absent → '') and verifies
  assert.equal(receiverVerify(id.pubkeyB64, minimal, sig), true);
});
