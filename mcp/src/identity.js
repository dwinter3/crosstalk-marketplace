// mcp/src/identity.js — the inter peer's L3 Ed25519 signing identity (#1179 client-signing half).
//
// An inter peer historically sent UNSIGNED envelopes — so even with the L4 dual-sign notary (#1219),
// the receiver had no origin signature to verify against a pinned key (origin_verified always 0).
// This gives the client an Ed25519 keypair and signs the OUTBOUND canonical, so a screen-vouched
// message can reach origin_verified=1 once (a) the receiver has pinned this peer's pubkey at onboard
// and (b) the L4 notary preserves the inner sig.
//
// SECURITY: the private key is generated ONCE on first run and persisted PEM (pkcs8) at 0600 under
// ~/.crosstalk/identity.pem. It NEVER leaves the machine and is never logged. Only the PUBLIC key
// (SPKI-DER-base64) + its sha256 fingerprint are ever surfaced (crosstalk_identity tool) for the
// admin to pin out-of-band. Rotation = delete the PEM (a new identity is minted on next start; the
// admin must re-pin the new fingerprint).

import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalEnvelope } from "./canonical-envelope.js";

/** SPKI-DER-base64 of a public key — the pinnable "advertised pubkey" form. */
function spkiB64(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}
/** Fingerprint = sha256 over the DER public key bytes (hex). The receiver OWNS fp derivation. */
function fingerprintOf(pubkeyB64) {
  return crypto.createHash("sha256").update(Buffer.from(pubkeyB64, "base64")).digest("hex");
}

/**
 * Load — or, on first run, generate + persist — this peer's Ed25519 identity.
 * @param {string} storePath  pkcs8 PEM path (created 0600 if absent)
 * @returns {{ privateKey: import("node:crypto").KeyObject, pubkeyB64: string, fingerprint: string }}
 * @throws if an existing key is unreadable or not ed25519 (caller fail-softs to unsigned send)
 */
export function loadOrCreateIdentity(storePath) {
  let priv;
  if (existsSync(storePath)) {
    priv = crypto.createPrivateKey(readFileSync(storePath, "utf8"));
    if (priv.asymmetricKeyType !== "ed25519") throw new Error("crosstalk identity key is not ed25519");
  } else {
    priv = crypto.generateKeyPairSync("ed25519").privateKey;
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, priv.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  }
  const pubkeyB64 = spkiB64(crypto.createPublicKey(priv));
  return { privateKey: priv, pubkeyB64, fingerprint: fingerprintOf(pubkeyB64) };
}

/**
 * Sign the canonical envelope of `canonical` with the peer's private key → base64 Ed25519 sig.
 * MUST sign the SAME canonicalEnvelope the receiver verifies (vendored here, byte-identical).
 * @param {import("node:crypto").KeyObject} privateKey
 * @param {object} canonical  { msg_id, thread_id?, from, to, subject, content, ts }
 * @returns {string} base64 signature
 */
export function signCanonical(privateKey, canonical) {
  return crypto.sign(null, Buffer.from(canonicalEnvelope(canonical), "utf8"), privateKey).toString("base64");
}
