// mcp/src/canonical-envelope.js — VENDORED, byte-identical copy of claude-mux's
// crosstalk/src/canonical-envelope.js (the receiver's canonical form).
//
// ⚠️ MUST STAY BYTE-IDENTICAL to the receiver's canonical-envelope.js. This client signs the
// canonical form below; the receiver (deliver-inbound, via identity.js) and the L4 screen notary
// rebuild + verify the SAME canonical. Any drift here → every signed message silently fails origin
// verification at the receiver (origin_verified=0) — a live-only failure that no local test catches
// (the #1185 lesson). The `v:1` version tag is the guard: a scheme change MUST bump v on BOTH sides
// in lock-step, so an accidental drift mis-verifies loudly rather than silently.
//
// Leaf module: ZERO imports. Do not add any.

/**
 * Canonical, deterministic serialization of an envelope's signed fields.
 * @param {object} m  { msg_id|id, thread_id, from, to, subject, content, ts }
 * @returns {string}  stable JSON used as the signature payload at sign AND verify
 */
export function canonicalEnvelope(m) {
  const mm = m || {};
  const msgId = mm.msg_id != null ? mm.msg_id : mm.id;
  return JSON.stringify({
    v: 1,
    msg_id: String(msgId == null ? '' : msgId),
    thread_id: String(mm.thread_id == null ? '' : mm.thread_id),
    from: String(mm.from == null ? '' : mm.from),
    to: String(mm.to == null ? '' : mm.to),
    subject: String(mm.subject == null ? '' : mm.subject),
    content: String(mm.content == null ? '' : mm.content),
    ts: String(mm.ts == null ? '' : mm.ts),
  });
}
