# Email Watcher (optional)

Systemd-based email notification when new crosstalk messages arrive in the
local inbox store (`~/.crosstalk/inbox.jsonl`). Designed for setups where
the MCP server's auto-poller writes to the local store, and you want email
alerts without keeping a Claude Code session running.

## Prerequisites

- Linux with systemd
- curl or Python 3 (for SMTP)
- An SMTP account for sending email

## Setup

```bash
cp smtp.conf.template ~/.crosstalk/watcher/smtp.conf
# edit ~/.crosstalk/watcher/smtp.conf with your SMTP settings
bash setup-debian.sh       # Debian/Ubuntu one-command setup
# or follow install.sh manually for other distros
```

## How it works

1. MCP server polls SQS -> writes messages to `~/.crosstalk/inbox.jsonl`
2. systemd path unit (`crosstalk-notify.path`) detects the file change
3. systemd service runs `notify.sh` which sends email via SMTP
