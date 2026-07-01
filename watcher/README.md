# Crosstalk Email Watcher (optional, non-Claude setups)

Systemd-based email notification when new crosstalk messages arrive in the
local inbox store (`~/.crosstalk/inbox.jsonl`). Designed for setups where
the Claude Code plugin's auto-poller is not running — the MCP server on this
branch includes a store-only poller that writes to inbox.jsonl, and this
watcher sends you an email when it detects new messages.

## Prerequisites

- systemd (Linux)
- curl or Python 3 (for SMTP)
- An SMTP account for sending email

## Setup

```bash
cp watcher/smtp.conf.template ~/.crosstalk/watcher/smtp.conf
# edit smtp.conf with your SMTP settings
bash watcher/setup-debian.sh   # or follow install.sh manually
bash watcher/install.sh
```

## How it works

1. MCP server polls SQS -> writes messages to `~/.crosstalk/inbox.jsonl`
2. systemd path unit (`crosstalk-notify.path`) detects the file change
3. systemd service (`crosstalk-notify.service`) runs `notify.sh`
4. `notify.sh` parses new unread messages and sends email via SMTP
