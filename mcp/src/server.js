#!/usr/bin/env node
// crosstalk MCP — screened, SQS-backed messaging for an INTER peer in their own Claude Code.
//
// Config: read from ~/.crosstalk/config.env (written by /crosstalk-join) — the CROSSTALK_SQS_COGNITO_*
// bootstrap + CROSSTALK_SQS_INBOX_URL. Creds resolve via the vendored cognito-creds resolver
// (User Pool auth -> Identity Pool -> scoped, auto-refreshing STS). The scoped role only permits
// SendMessage to the screen queues the ACL grants, and Receive/Delete on the peer's own inbox — so a
// send to a non-granted recipient hard-fails AccessDenied (by design). Every send is L4-screened.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveCognitoCreds, cognitoConfigFromEnv } from "./cognito-creds.js";
import { sendMessage, receiveMessages, deleteMessage } from "./sqs.js";
import { loadOrCreateIdentity, signCanonical } from "./identity.js";

const CONFIG_PATH = process.env.CROSSTALK_CONFIG || join(homedir(), ".crosstalk", "config.env");

// Parse a KEY=VALUE env file (tolerates `export `, quotes, comments) into an object.
function loadConfig(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (let line of readFileSync(path, "utf8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim().replace(/\s+#.*$/, "");
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// Derive {region, account, peer} from the own-inbox URL:
//   https://sqs.<region>.amazonaws.com/<account>/crosstalk-inbox-<peer>.fifo
function parseInboxUrl(url) {
  const m = /^https:\/\/sqs\.([^.]+)\.amazonaws\.com\/(\d{12})\/crosstalk-inbox-(.+)\.fifo$/.exec(url || "");
  if (!m) return null;
  return { region: m[1], account: m[2], peer: m[3] };
}

const screenQueueUrl = (region, account, to) =>
  `https://sqs.${region}.amazonaws.com/${account}/crosstalk-screen-${to}.fifo`;

const cfg = loadConfig(CONFIG_PATH);
const cognito = cognitoConfigFromEnv(cfg); // reads CROSSTALK_SQS_COGNITO* keys out of the parsed file
const inbox = parseInboxUrl(cfg.CROSSTALK_SQS_INBOX_URL);
const ready = !!(cognito && inbox);

// #1179 — the peer's L3 signing identity (first-run mints + persists ~/.crosstalk/identity.pem, 0600).
// FAIL-SOFT: if it can't load/create, we send UNSIGNED (today's behavior) rather than block sends.
const IDENTITY_PATH = process.env.CROSSTALK_IDENTITY || join(homedir(), ".crosstalk", "identity.pem");
let identity = null;
if (ready) {
  try { identity = loadOrCreateIdentity(IDENTITY_PATH); }
  catch (e) { process.stderr.write(`crosstalk: signing identity unavailable (${e?.message || e}); sending unsigned\n`); }
}

// Build the outbound envelope body, SIGNED when an identity is present (#1179). The canonical fields
// {msg_id, from, to, subject, content, ts} are signed via the vendored canonicalEnvelope — byte-identical
// to the receiver's — and sig/advertised_pubkey/from_node are attached OUTSIDE the canonical (the L4
// notary preserves them as the inner `origin` block). Fail-soft to unsigned on any signing error.
function buildBody({ from, to, subject, content }) {
  const msg_id = randomBytes(8).toString("hex");
  const ts = new Date().toISOString();
  const base = { from, to, subject: subject || "", content, msg_id, ts };
  if (identity) {
    try {
      const sig = signCanonical(identity.privateKey, { msg_id, from, to, subject: subject || "", content, ts });
      return JSON.stringify({ ...base, sig, advertised_pubkey: identity.pubkeyB64, from_node: from });
    } catch (e) {
      process.stderr.write(`crosstalk: sign failed (${e?.message || e}); sending unsigned\n`);
    }
  }
  return JSON.stringify(base);
}

async function creds() {
  return resolveCognitoCreds({
    region: cognito.region,
    userPoolId: cognito.userPoolId,
    clientId: cognito.clientId,
    identityPoolId: cognito.identityPoolId,
    username: cognito.username,
    // #2 — forward the refresh token. The portal flow is refresh-token-ONLY (no password), so
    // without this resolveCognitoCreds saw neither and threw "no refreshToken and no password".
    // resolveCognitoCreds prefers refreshToken over password (REFRESH_TOKEN_AUTH); password is the
    // legacy first-auth fallback only.
    refreshToken: cognito.refreshToken,
    password: cognito.password,
  });
}

function notReadyResult() {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `crosstalk is not configured yet. Run /crosstalk-join to sign in, get approved, and install your credentials to ${CONFIG_PATH}.`,
    }],
  };
}

const server = new McpServer({ name: "crosstalk", version: "0.1.0" });

server.tool(
  "send_message",
  "Send a crosstalk message to a peer. Routes through the content screen (academic/discussion only; operational content is blocked by design). You can only reach peers you've been granted access to.",
  { to: z.string().describe("recipient peer name"), subject: z.string().optional(), content: z.string().describe("message body") },
  async ({ to, subject, content }) => {
    if (!ready) return notReadyResult();
    const body = buildBody({ from: inbox.peer, to, subject: subject || "", content });
    try {
      const c = await creds();
      const r = await sendMessage({ region: inbox.region, queueUrl: screenQueueUrl(inbox.region, inbox.account, to), body, creds: c });
      return { content: [{ type: "text", text: `Sent to ${to} via the content screen (MessageId ${r.MessageId || "?"}). It will be delivered if it passes screening.` }] };
    } catch (e) {
      const msg = String(e?.message || e);
      const hint = /AccessDenied|not authorized/i.test(msg) ? ` — you don't have a grant to message "${to}" (ask the admin to grant it).` : "";
      return { isError: true, content: [{ type: "text", text: `send failed: ${msg.split("\n").slice(-2).join(" ").slice(0, 300)}${hint}` }] };
    }
  },
);

server.tool(
  "check_inbox",
  "Fetch and acknowledge new crosstalk messages from your own inbox.",
  { limit: z.number().int().min(1).max(10).optional() },
  async ({ limit }) => {
    if (!ready) return notReadyResult();
    try {
      const c = await creds();
      const msgs = await receiveMessages({ region: inbox.region, queueUrl: cfg.CROSSTALK_SQS_INBOX_URL, max: limit || 5, creds: c });
      if (!msgs.length) return { content: [{ type: "text", text: "No new messages." }] };
      const out = [];
      for (const m of msgs) {
        let parsed; try { parsed = JSON.parse(m.Body); } catch { parsed = { content: m.Body }; }
        out.push(`from ${parsed.from || "?"}${parsed.subject ? ` [${parsed.subject}]` : ""}: ${parsed.content || ""}`);
        try { await deleteMessage({ region: inbox.region, queueUrl: cfg.CROSSTALK_SQS_INBOX_URL, receiptHandle: m.ReceiptHandle, creds: c }); } catch { /* best-effort ack */ }
      }
      return { content: [{ type: "text", text: out.join("\n\n") }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `check_inbox failed: ${String(e?.message || e).split("\n").slice(-2).join(" ").slice(0, 300)}` }] };
    }
  },
);

server.tool(
  "reply",
  "Reply to a peer (convenience over send_message).",
  { to: z.string(), content: z.string(), subject: z.string().optional() },
  async ({ to, content, subject }) => {
    if (!ready) return notReadyResult();
    // Same path as send_message; thread context is carried in the subject for now.
    const body = buildBody({ from: inbox.peer, to, subject: subject || "re:", content });
    try {
      const c = await creds();
      const r = await sendMessage({ region: inbox.region, queueUrl: screenQueueUrl(inbox.region, inbox.account, to), body, creds: c });
      return { content: [{ type: "text", text: `Reply sent to ${to} (MessageId ${r.MessageId || "?"}).` }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `reply failed: ${String(e?.message || e).split("\n").slice(-2).join(" ").slice(0, 300)}` }] };
    }
  },
);

server.tool(
  "crosstalk_identity",
  "Show this peer's signing identity — public key + fingerprint — so the network admin can pin it out-of-band (enables cryptographic origin-verification of your messages). The private key never leaves this machine.",
  {},
  async () => {
    if (!ready) return notReadyResult();
    if (!identity) return { isError: true, content: [{ type: "text", text: "No signing identity is available (it could not be created); messages are sent unsigned." }] };
    return { content: [{ type: "text", text:
      `peer:        ${inbox.peer}\n` +
      `public key:  ${identity.pubkeyB64}\n` +
      `fingerprint: ${identity.fingerprint}\n\n` +
      `Send the fingerprint to the network admin out-of-band so they can pin your key.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
