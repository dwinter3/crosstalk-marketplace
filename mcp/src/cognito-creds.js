// crosstalk MCP — Cognito credential resolver (SDK-native; no AWS CLI dependency).
//
//   User Pool auth (USER_PASSWORD_AUTH first time -> refresh token; REFRESH_TOKEN_AUTH thereafter)
//     -> ID token
//          -> Identity Pool GetId + GetCredentialsForIdentity ("Choose role from token")
//               -> scoped, TEMPORARY AWS creds (auto-refreshing -> no 1h cliff).
//
// SDK-native (replaces the earlier AWS-CLI shell-out) so the plugin is self-contained — the only
// runtime prereq is Node. InitiateAuth / GetId / GetCredentialsForIdentity are Cognito's
// UNAUTHENTICATED operations, so the SDK clients need no caller AWS credentials (a credential-less
// external peer can run this). SQS (sqs.js) DOES need the scoped creds these vend.
//
// SECURITY: never logs tokens/creds; the refresh token is passed in-process (never argv) and
// persisted 0600. Inert until called.

import {
  CognitoIdentityProviderClient, InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME || homedir();
const STORE_DIR = join(HOME, ".claude-mux", "inter-cognito");
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const _cache = new Map();

const _storePath = (u) => join(STORE_DIR, `${u}.json`);

export function readPersistedRefreshToken(username, { storePath } = {}) {
  try {
    const j = JSON.parse(readFileSync(storePath || _storePath(username), "utf8"));
    return j && typeof j.refreshToken === "string" && j.refreshToken ? j.refreshToken : null;
  } catch { return null; }
}

function _persistRefreshToken(username, refreshToken, { storePath } = {}) {
  try {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(STORE_DIR, 0o700); } catch { /* best-effort */ }
    writeFileSync(storePath || _storePath(username),
      JSON.stringify({ refreshToken, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

async function _userPoolAuth({ region, clientId, username, refreshToken, password }) {
  const client = new CognitoIdentityProviderClient({ region }); // unauthenticated op — no caller creds
  let params;
  if (refreshToken) {
    params = { ClientId: clientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: refreshToken } };
  } else if (password) {
    params = { ClientId: clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: username, PASSWORD: password } };
  } else {
    throw new Error("cognito: no refreshToken and no password — cannot authenticate");
  }
  const resp = await client.send(new InitiateAuthCommand(params));
  const ar = resp && resp.AuthenticationResult;
  if (!ar || !ar.IdToken) {
    throw new Error(`cognito: auth did not return an ID token (challenge=${resp && resp.ChallengeName ? resp.ChallengeName : "no-auth-result"})`);
  }
  const newRefresh = (ar.RefreshToken && typeof ar.RefreshToken === "string") ? ar.RefreshToken : (refreshToken || null);
  return { idToken: ar.IdToken, refreshToken: newRefresh };
}

async function _identityPoolCreds({ region, identityPoolId, userPoolProvider, idToken }) {
  const client = new CognitoIdentityClient({ region }); // unauthenticated identity op — no caller creds
  const logins = { [userPoolProvider]: idToken };
  const idResp = await client.send(new GetIdCommand({ IdentityPoolId: identityPoolId, Logins: logins }));
  if (!idResp || !idResp.IdentityId) throw new Error("cognito: GetId returned no IdentityId");
  const credResp = await client.send(new GetCredentialsForIdentityCommand({ IdentityId: idResp.IdentityId, Logins: logins }));
  const c = credResp && credResp.Credentials;
  if (!c || !c.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error("cognito: GetCredentialsForIdentity returned incomplete credentials");
  }
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken, expiration: c.Expiration };
}

function _expirationToMs(expiration) {
  if (expiration == null) return 0;
  if (expiration instanceof Date) return expiration.getTime();
  if (typeof expiration === "number") return expiration > 1e12 ? expiration : expiration * 1000;
  const t = Date.parse(String(expiration));
  return Number.isFinite(t) ? t : 0;
}

export async function resolveCognitoCreds(cfg) {
  const { region, userPoolId, clientId, identityPoolId, username, refreshToken: explicitRefresh, password, storePath, force } = cfg || {};
  if (!region || !userPoolId || !clientId || !identityPoolId || !username) {
    throw new Error("cognito: missing required config (region, userPoolId, clientId, identityPoolId, username)");
  }
  const userPoolProvider = cfg.userPoolProvider || `cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  const cached = _cache.get(username);
  if (!force && cached && cached.expiresAtMs - Date.now() > REFRESH_SKEW_MS) return cached.creds;

  const refreshToken = explicitRefresh || readPersistedRefreshToken(username, { storePath });
  const { idToken, refreshToken: newRefresh } = await _userPoolAuth({ region, clientId, username, refreshToken, password });
  if (newRefresh && newRefresh !== refreshToken) _persistRefreshToken(username, newRefresh, { storePath });

  const creds = await _identityPoolCreds({ region, identityPoolId, userPoolProvider, idToken });
  const expiresAtMs = _expirationToMs(creds.expiration) || (Date.now() + 50 * 60 * 1000);
  const out = { ...creds, expiresAtMs };
  _cache.set(username, { creds: out, expiresAtMs });
  return out;
}

export function _clearCognitoCache() { _cache.clear(); }

/** OPT-IN config from env (or a parsed config.env object). ABSENT (CROSSTALK_SQS_COGNITO!=="1") -> null. */
export function cognitoConfigFromEnv(env = process.env) {
  if (env.CROSSTALK_SQS_COGNITO !== "1") return null;
  const region = env.CROSSTALK_SQS_COGNITO_REGION;
  const userPoolId = env.CROSSTALK_SQS_COGNITO_USER_POOL_ID;
  const clientId = env.CROSSTALK_SQS_COGNITO_CLIENT_ID;
  const identityPoolId = env.CROSSTALK_SQS_COGNITO_IDENTITY_POOL_ID;
  const username = env.CROSSTALK_SQS_COGNITO_USERNAME;
  if (!region || !userPoolId || !clientId || !identityPoolId || !username) return null;
  const out = { region, userPoolId, clientId, identityPoolId, username };
  out.peer = env.CROSSTALK_SQS_COGNITO_PEER || username;
  if (env.CROSSTALK_SQS_COGNITO_PROVIDER) out.userPoolProvider = env.CROSSTALK_SQS_COGNITO_PROVIDER;
  if (env.CROSSTALK_SQS_COGNITO_PASSWORD) out.password = env.CROSSTALK_SQS_COGNITO_PASSWORD;
  // Kill-2: the CLI-auth loopback can supply a refresh token directly (no password ever).
  if (env.CROSSTALK_SQS_COGNITO_REFRESH_TOKEN) out.refreshToken = env.CROSSTALK_SQS_COGNITO_REFRESH_TOKEN;
  return out;
}
