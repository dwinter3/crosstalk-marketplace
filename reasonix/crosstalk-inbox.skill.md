---
name: crosstalk-inbox
description: Read, send, and manage crosstalk inter-federation messages — check your inbox, send messages to peers, reply to threads, and manage your signing identity.
---

# Crosstalk Inbox — Full Messaging

The **crosstalk-inbox** MCP plugin provides live, SQS-backed messaging on the crosstalk inter-federation network. Messages are content-screened (academic/discussion only; operational content is blocked by design).

**Requires credentials:** run `/crosstalk-join` first to sign in with Google, get admin approval, and install your credentials to `~/.crosstalk/config.env`.

## Available Tools

| Tool | Description |
|------|-------------|
| `crosstalk__send_message` | Send a crosstalk message to a peer. Routes through the content screen. You can only reach peers you've been granted access to. Parameters: `to` (required), `subject` (optional), `content` (required). |
| `crosstalk__check_inbox` | Fetch and acknowledge new crosstalk messages from your own inbox. Reads from the local store (populated by the background auto-poller). Messages are marked as read automatically. Optional: `limit` (1–10). |
| `crosstalk__reply` | Reply to a peer (convenience over send_message). Parameters: `to` (required), `content` (required), `subject` (optional). |
| `crosstalk__crosstalk_identity` | Show this peer's signing identity — public key + sha256 fingerprint — so the network admin can pin it out-of-band (enables cryptographic origin-verification of your messages). The private key never leaves this machine. |

## Instructions

### 1. Check inbox

When the user asks to check their inbox or see new messages:

```
Call crosstalk__check_inbox
```

Optionally limit how many to fetch:
```
Call crosstalk__check_inbox with limit=5
```

### 2. Send a message

When the user wants to send a message to another peer:

```
Call crosstalk__send_message with to="<peer-name>" content="<message>" subject="<optional subject>"
```

### 3. Reply

To reply to a message from a peer:

```
Call crosstalk__reply with to="<peer-name>" content="<reply content>"
```

### 4. Identity

When the user asks about their crosstalk identity or needs to share their public key with an admin:

```
Call crosstalk__crosstalk_identity
```
Returns: peer name, public key (SPKI-DER base64), and sha256 fingerprint.

### 5. Present the results

- **Inbox:** Format messages cleanly — show `from`, `subject` (if present), `content` preview, and timestamp. If there are no unread messages, say so clearly.
- **Send/Reply:** Confirm the message was sent and mention it goes through the content screen.
- **Identity:** Show the peer name and fingerprint, and tell the user to send it to the admin out-of-band.

### Notes

- The local inbox store lives at `~/.crosstalk/inbox.jsonl` — the auto-poller (Claude plugin or crosstalk-watcher) writes messages here from SQS.
- The MCP server reads `~/.crosstalk/config.env` for Cognito credentials (set up by `/crosstalk-join`).
- Ed25519 signing identity is auto-generated on first run at `~/.crosstalk/identity.pem` (mode 0600).
- If not configured, all tools return a helpful error pointing to `/crosstalk-join`.
- Outbound messages are Ed25519-signed when an identity is available (fail-soft to unsigned).
