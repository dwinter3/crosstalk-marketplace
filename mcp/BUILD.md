# crosstalk MCP — build

The SQS-backed crosstalk MCP server.

## Build

```bash
cd mcp
npm install
npm run build   # outputs dist/server.js
```

## Runtime prereqs

- Node.js >=20
- `~/.crosstalk/config.env` with Cognito credentials (set up by onboarding)

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send a screened message to a peer via SQS |
| `check_inbox` | Read unread messages from the local inbox store |
| `reply` | Convenience wrapper over send_message |
| `crosstalk_identity` | Show Ed25519 public key + fingerprint |

## Files

| Source | Purpose |
|--------|---------|
| `src/server.js` | Main MCP server — 4 tools, store-only auto-poller |
| `src/cognito-creds.js` | Cognito User Pool -> Identity Pool -> STS |
| `src/sqs.js` | SQS send/receive/delete |
| `src/inbox-store.js` | Durable local inbox with dedup + compaction |
| `src/identity.js` | Ed25519 keypair generation, persistence, signing |
| `src/canonical-envelope.js` | Byte-identical canonical envelope serialization |
