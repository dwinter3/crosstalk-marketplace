// crosstalk/src/cognito-creds.js
// #1164 Phase 3 — the daemon's Cognito credential resolver for INTER (external-human) peers.
//
// An external human (e.g. "Stacy") has no AWS identity in the relay account (554), so she cannot
// self-mint / refresh the 1h STS creds the SQS relay needs (#1161 proved the 1h cliff is real). The
// INTRA path (lib/sqs-relay.sh, Model B) assumes the caller is already in 554; INTER peers are not.
// This resolver federates her identity through Cognito:
//
//   User Pool auth (USER_PASSWORD_AUTH first time → refresh token; REFRESH_TOKEN_AUTH thereafter)
//     └─ ID token
//          └─ Identity Pool GetId + GetCredentialsForIdentity ("Choose role from token")
//               └─ scoped, TEMPORARY AWS creds (ASIA… + Expiration) — the per-peer IAM role's scope.
//
// The Cognito refresh-token flow AUTO-REFRESHES, so #1161's 1h cliff disappears for inter peers: we
// cache the vended creds + re-resolve (via the persisted refresh token) before they expire.
//
// NO AWS SDK DEP in crosstalk (checked: package.json has @anthropic-ai/sdk, @modelcontextprotocol/sdk,
// better-sqlite3 — no @aws-sdk), so we SHELL OUT to the AWS CLI, mirroring sqs-cli-client.js.
//
// SECURITY INVARIANTS (tested in crosstalk/test/cognito-creds.test.js):
//   - NEVER log tokens or creds (no console.* of any secret; the optional `log` only gets a redacted
//     one-liner).
//   - The password / refresh token / ID token are passed via a 0600 `--cli-input-json file://`
//     tempfile, NEVER on argv (the #597 continuity — `ps`/process listings can't leak them).
//   - The persisted refresh-token store is written 0600.
//   - This module is INERT until called: importing it has zero effect on the existing relay path.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const HOME = process.env.HOME || homedir();
const COGNITO_STORE_DIR = join(HOME, ".claude-mux", "inter-cognito");

// Re-resolve when fewer than this many ms of cred lifetime remain (kills the #1161 cliff by
// re-vending BEFORE expiry, never after). 5 min default — well inside Cognito's ≥15-min creds.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// In-process cache keyed by username → { creds, expiresAtMs }.
const _credCache = new Map();

/** Redact a token/cred for a log line — show only that it's present + its length. */
function _redact(v) {
  if (!v) return "<none>";
  return `<redacted:${String(v).length}b>`;
}

/**
 * Run an AWS CLI subcommand whose INPUT carries a secret (password / token), passing the input via a
 * 0600 `--cli-input-json file://` tempfile so the secret never lands on argv. Returns parsed JSON.
 * @param {string[]} baseArgv  e.g. ["cognito-idp","initiate-auth","--region","us-east-1"]
 * @param {object} inputObj    the request body (may contain secrets)
 * @param {function} exec      promisified execFile (injectable for tests)
 */
async function _awsWithSecretInput(baseArgv, inputObj, exec) {
  const f = join(tmpdir(), `ct-cognito-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(f, JSON.stringify(inputObj), { mode: 0o600 });
  try {
    const argv = [...baseArgv, "--cli-input-json", "file://" + f, "--output", "json"];
    const { stdout } = await exec("aws", argv, { maxBuffer: 10 * 1024 * 1024 });
    return stdout && stdout.trim() ? JSON.parse(stdout) : {};
  } finally {
    try { unlinkSync(f); } catch { /* best-effort */ }
  }
}

/** Path to a peer's persisted refresh-token store (0600). */
function _storePath(username) {
  return join(COGNITO_STORE_DIR, `${username}.json`);
}

/** Read a persisted refresh token for a peer (or null). NEVER logs it. */
export function readPersistedRefreshToken(username, { storePath } = {}) {
  try {
    const p = storePath || _storePath(username);
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j.refreshToken === "string" && j.refreshToken ? j.refreshToken : null;
  } catch { return null; }
}

/** Persist a peer's refresh token 0600. NEVER logs it. */
function _persistRefreshToken(username, refreshToken, { storePath } = {}) {
  try {
    mkdirSync(COGNITO_STORE_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(COGNITO_STORE_DIR, 0o700); } catch { /* best-effort */ }
    const p = storePath || _storePath(username);
    writeFileSync(p, JSON.stringify({ refreshToken, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch { /* a persist failure is non-fatal — we still return creds this run */ }
}

/**
 * Authenticate to the User Pool and return the ID token (+ a refresh token when issued).
 * REFRESH_TOKEN_AUTH when a refresh token is present; else USER_PASSWORD_AUTH with the password
 * (which also yields + persists a refresh token for next time). Secrets ride a 0600 file, not argv.
 * @returns {Promise<{idToken:string, refreshToken:(string|null)}>}
 */
async function _userPoolAuth({ region, clientId, username, refreshToken, password }, exec) {
  const base = ["cognito-idp", "initiate-auth", "--region", region];
  let input;
  if (refreshToken) {
    input = { ClientId: clientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: refreshToken } };
  } else if (password) {
    input = { ClientId: clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: username, PASSWORD: password } };
  } else {
    throw new Error("cognito: no refreshToken and no password — cannot authenticate");
  }
  const resp = await _awsWithSecretInput(base, input, exec);
  const ar = resp && resp.AuthenticationResult;
  if (!ar || !ar.IdToken) {
    // A NEW_PASSWORD_REQUIRED / MFA challenge has no AuthenticationResult — the peer must complete it
    // interactively first (the onboard bootstrap's "set a real password" step). Surface a clear,
    // SECRET-FREE error (never echo the challenge params, which can carry session tokens).
    const ch = resp && resp.ChallengeName ? resp.ChallengeName : "no-auth-result";
    throw new Error(`cognito: auth did not return an ID token (challenge=${ch})`);
  }
  // REFRESH_TOKEN_AUTH does NOT re-issue a refresh token; USER_PASSWORD_AUTH does. Keep the existing
  // one when none came back.
  const newRefresh = (ar.RefreshToken && typeof ar.RefreshToken === "string") ? ar.RefreshToken : (refreshToken || null);
  return { idToken: ar.IdToken, refreshToken: newRefresh };
}

/**
 * Exchange an ID token for scoped AWS creds via the Identity Pool (GetId → GetCredentialsForIdentity).
 * The ID token (a secret) rides a 0600 file in the `--logins` map, never on argv.
 * @returns {Promise<{accessKeyId, secretAccessKey, sessionToken, expiration}>}
 */
async function _identityPoolCreds({ region, identityPoolId, userPoolProvider, idToken }, exec) {
  const loginsKey = userPoolProvider; // e.g. cognito-idp.us-east-1.amazonaws.com/us-east-1_xxxx
  const logins = { [loginsKey]: idToken };

  // GetId — resolve the identity id for this login. (The id is non-secret, but the login token IS, so
  // still file-fed.)
  const idResp = await _awsWithSecretInput(
    ["cognito-identity", "get-id", "--region", region],
    { IdentityPoolId: identityPoolId, Logins: logins },
    exec,
  );
  const identityId = idResp && idResp.IdentityId;
  if (!identityId) throw new Error("cognito: GetId returned no IdentityId");

  // GetCredentialsForIdentity — "Choose role from token" vends the per-peer scoped role's temp creds.
  const credResp = await _awsWithSecretInput(
    ["cognito-identity", "get-credentials-for-identity", "--region", region],
    { IdentityId: identityId, Logins: logins },
    exec,
  );
  const c = credResp && credResp.Credentials;
  if (!c || !c.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error("cognito: GetCredentialsForIdentity returned incomplete credentials");
  }
  // Cognito returns SecretKey (not SecretAccessKey) + Expiration as an epoch-seconds number.
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration, // epoch seconds (number) or ISO string depending on CLI; normalized below
  };
}

/** Normalize an Expiration (epoch-seconds number, or ISO string) to epoch-ms. 0 on failure. */
function _expirationToMs(expiration) {
  if (expiration == null) return 0;
  if (typeof expiration === "number") {
    // Cognito returns epoch SECONDS; guard against accidental ms.
    return expiration > 1e12 ? expiration : expiration * 1000;
  }
  const t = Date.parse(String(expiration));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Resolve scoped, auto-refreshing AWS creds for an inter peer via Cognito.
 *
 * @param {object} cfg
 * @param {string} cfg.region
 * @param {string} cfg.userPoolId
 * @param {string} cfg.clientId
 * @param {string} cfg.identityPoolId
 * @param {string} cfg.username
 * @param {string} [cfg.userPoolProvider]  cognito-idp.<region>.amazonaws.com/<userPoolId> (derived if absent)
 * @param {string} [cfg.refreshToken]      explicit refresh token (else the persisted one is used)
 * @param {string} [cfg.password]          initial password (only used when no refresh token exists)
 * @param {function} [cfg.execFileAsync]   injectable exec (tests)
 * @param {function} [cfg.log]             optional logger — only ever receives REDACTED lines
 * @param {string} [cfg.storePath]         override the refresh-token store path (tests)
 * @param {boolean} [cfg.force]            ignore the cache + re-vend
 * @returns {Promise<{accessKeyId, secretAccessKey, sessionToken, expiration, expiresAtMs}>}
 */
export async function resolveCognitoCreds(cfg) {
  const {
    region, userPoolId, clientId, identityPoolId, username,
    refreshToken: explicitRefresh, password,
    execFileAsync, log, storePath, force,
  } = cfg || {};

  if (!region || !userPoolId || !clientId || !identityPoolId || !username) {
    throw new Error("cognito: missing required config (region, userPoolId, clientId, identityPoolId, username)");
  }
  const exec = execFileAsync || promisify(execFile);
  const userPoolProvider = cfg.userPoolProvider || `cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  // 1. Cache hit with comfortable headroom → return it (the auto-refresh: re-vend only near expiry).
  const cached = _credCache.get(username);
  if (!force && cached && cached.expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
    return cached.creds;
  }

  // 2. Pick the refresh token: explicit > persisted. Fall back to password for the very first auth.
  const refreshToken = explicitRefresh || readPersistedRefreshToken(username, { storePath });

  // 3. User Pool auth → ID token (+ maybe a fresh refresh token to persist).
  const { idToken, refreshToken: newRefresh } = await _userPoolAuth(
    { region, clientId, username, refreshToken, password }, exec,
  );
  if (newRefresh && newRefresh !== refreshToken) {
    _persistRefreshToken(username, newRefresh, { storePath });
  }

  // 4. Identity Pool → scoped temp creds.
  const creds = await _identityPoolCreds({ region, identityPoolId, userPoolProvider, idToken }, exec);

  // 5. Cache by computed expiry.
  const expiresAtMs = _expirationToMs(creds.expiration) || (Date.now() + 50 * 60 * 1000);
  const out = { ...creds, expiresAtMs };
  _credCache.set(username, { creds: out, expiresAtMs });

  if (typeof log === "function") {
    // REDACTED only — never the tokens/creds.
    log(`cognito: resolved scoped creds for ${username} (akid=${_redact(creds.accessKeyId)}, exp=${new Date(expiresAtMs).toISOString()}, refresh=${refreshToken ? "reused" : "initial"})`);
  }
  return out;
}

/** Clear the in-process cache (tests / a forced re-vend). */
export function _clearCognitoCache() { _credCache.clear(); }

/**
 * Decide whether a Cognito config is present (the OPT-IN gate). Reads env first, then a peer
 * descriptor file. ABSENT → null → the caller keeps its existing static-relay-env path UNCHANGED
 * (the critical byte-identical invariant for intra daemons).
 * @param {object} [env=process.env]
 * @returns {null | {region, userPoolId, clientId, identityPoolId, username, userPoolProvider?, password?}}
 */
export function cognitoConfigFromEnv(env = process.env) {
  if (env.CROSSTALK_SQS_COGNITO !== "1") return null;
  const region = env.CROSSTALK_SQS_COGNITO_REGION;
  const userPoolId = env.CROSSTALK_SQS_COGNITO_USER_POOL_ID;
  const clientId = env.CROSSTALK_SQS_COGNITO_CLIENT_ID;
  const identityPoolId = env.CROSSTALK_SQS_COGNITO_IDENTITY_POOL_ID;
  const username = env.CROSSTALK_SQS_COGNITO_USERNAME;
  // All five are required; an incomplete config is treated as ABSENT (fail-safe to the static path).
  if (!region || !userPoolId || !clientId || !identityPoolId || !username) return null;
  const out = { region, userPoolId, clientId, identityPoolId, username };
  // The Cognito USERNAME is the email (the pool enforces email-as-username); the crosstalk PEER
  // identity (inbox-queue key + ACL `from`) is the short <peer> name. They differ by design — the
  // descriptor links them. `peer` defaults to the username for an intra-shaped config.
  out.peer = env.CROSSTALK_SQS_COGNITO_PEER || username;
  if (env.CROSSTALK_SQS_COGNITO_PROVIDER) out.userPoolProvider = env.CROSSTALK_SQS_COGNITO_PROVIDER;
  // A password may be supplied for the first-ever auth (then the persisted refresh token takes over).
  if (env.CROSSTALK_SQS_COGNITO_PASSWORD) out.password = env.CROSSTALK_SQS_COGNITO_PASSWORD;
  return out;
}
