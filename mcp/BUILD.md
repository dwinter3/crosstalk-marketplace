# crosstalk MCP (bundled in the plugin) — build plan

The standalone, SQS-backed crosstalk client that ships **inside** the `crosstalk` plugin, so an
approved external peer gets live messaging tools in their own Claude Code. This is the genuinely
new code (the existing claude-mux crosstalk MCP is tied to a local SQLite DB + the p2p daemon;
an inter peer has neither — only Cognito creds + an SQS inbox + a scoped role).

## Identity / creds (reuse, don't reinvent)
Reads `~/.crosstalk/config.env` (written by `/crosstalk-join`): `CROSSTALK_SQS_COGNITO_*`.
Reuses the proven resolver pattern from `claude-mux/crosstalk/src/cognito-creds.js`:
USER_PASSWORD_AUTH (initial) -> persist refresh token -> Identity Pool get-id +
get-credentials-for-identity -> scoped STS (auto-refresh; no 1h cliff). No secret on argv/logs.

## Tools (curated, minimal)
- `send_message({ to, subject, content })` — send to recipient `to`. For an inter peer, the
  scoped role only allows SendMessage to the **screen queue(s)** the ACL grants
  (`crosstalk-screen-<to>.fifo`). A send to a non-granted `to` hard-fails AccessDenied (by design).
  Envelope shape matches the relay: `{from, to, subject, content, msg_id}`, FIFO group `crosstalk`.
- `check_inbox({ limit })` — receive from the peer's OWN inbox (`crosstalk-inbox-<peer>.fifo`),
  return messages, delete after read (ack). Receive/Delete scoped to own inbox only.
- `reply({ thread_id, content })` — convenience over send_message preserving thread context.

## Inbound (fold the daemon IN — no separate process)
The MCP server runs while Claude Code is open, so it polls the own-inbox on an interval and
surfaces new messages (the host's MCP notification path / a `check_inbox`-on-poll cache). SQS is
durable store-and-forward, so messages wait while the peer is offline — acceptable for an
interactive peer, and it eliminates the separate launchd/systemd daemon the npx approach needed.

## Screening invariant (must surface honestly)
Every outbound rides the L4 content screen. Operational/credential/remote-exec-shaped content is
blocked + quarantined by design (this is a discussion channel). The tool result must report a
block clearly, not silently drop.

## Plugin wiring
plugin.json `mcpServers`: `{ "crosstalk": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"] } }`
(verify the plugin-root env var name against current Claude Code plugin docs).

## Open items
- Cognito NEW_PASSWORD_REQUIRED on first auth (the invite temp password) — handle in `/crosstalk-join`
  or a first-run prompt in the MCP.
- Bundle the AWS SDK (sqs, cognito-identity, cognito-identity-provider) in the plugin's node_modules.
- Sender identity: messages claim `from=<peer>`; the SCREEN + the recipient's L3 layer judge it
  (transport is ground truth — an inter peer can't forge a tailnet identity over SQS).
