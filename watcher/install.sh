#!/usr/bin/env bash
# install.sh — set up the crosstalk email watcher as a systemd user service
# Run this AFTER editing smtp.conf with your email credentials.
# Usage:  bash ~/.crosstalk/watcher/install.sh
set -euo pipefail

WATCHER_DIR="$HOME/.crosstalk/watcher"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "=== crosstalk email watcher — install ==="
echo ""

# ── Create config from template if missing ─────────────────────────────────────
if [ ! -f "$WATCHER_DIR/smtp.conf" ]; then
  cp "$WATCHER_DIR/smtp.conf.template" "$WATCHER_DIR/smtp.conf"
  chmod 0600 "$WATCHER_DIR/smtp.conf"
fi

# ── Check config ──────────────────────────────────────────────────────────────
if ! grep -q "NOTIFY_TO=" "$WATCHER_DIR/smtp.conf" 2>/dev/null; then
  echo "ERROR: smtp.conf not found or incomplete."
  echo "  Edit $WATCHER_DIR/smtp.conf first, then re-run this script."
  exit 1
fi

TO=$(source "$WATCHER_DIR/smtp.conf" && echo "$NOTIFY_TO")
if [ -z "$TO" ] || [ "$TO" = "you@example.com" ]; then
  echo "ERROR: NOTIFY_TO is still set to the placeholder 'you@example.com'."
  echo "  Edit $WATCHER_DIR/smtp.conf with your real email address."
  exit 1
fi
echo "  → Will notify: $TO"
echo ""

# ── Permissions ───────────────────────────────────────────────────────────────
chmod 0700 "$WATCHER_DIR"
chmod 0700 "$WATCHER_DIR/notify.sh"
chmod 0600 "$WATCHER_DIR/smtp.conf"
echo "  → Permissions set (0700 dir, 0600 config)"

# ── Install systemd units ─────────────────────────────────────────────────────
mkdir -p "$SYSTEMD_DIR"
cp "$WATCHER_DIR/crosstalk-notify.path" "$SYSTEMD_DIR/"
cp "$WATCHER_DIR/crosstalk-notify.service" "$SYSTEMD_DIR/"
echo "  → Units installed to $SYSTEMD_DIR"

# Reload systemd
systemctl --user daemon-reload
echo "  → systemd daemon reloaded"

# ── Enable & start ────────────────────────────────────────────────────────────
systemctl --user enable --now crosstalk-notify.path
echo "  → crosstalk-notify.path enabled & started"
echo ""

# ── Verify ────────────────────────────────────────────────────────────────────
echo "Status:"
systemctl --user status crosstalk-notify.path --no-pager 2>&1 || true
echo ""
systemctl --user status crosstalk-notify.service --no-pager 2>&1 || true
echo ""

# ── Test send ─────────────────────────────────────────────────────────────────
echo "=== Test: sending a test email to $TO ==="
echo ""
"$WATCHER_DIR/notify.sh" 2>&1 || true
echo ""

echo "=== Done ==="
echo ""
echo "Commands:"
echo "  systemctl --user status crosstalk-notify.path   # check watcher"
echo "  systemctl --user stop crosstalk-notify.path      # pause"
echo "  systemctl --user start crosstalk-notify.path     # resume"
echo "  journalctl --user -u crosstalk-notify.service -f # follow logs"
echo ""
echo "To test manually:  touch ~/.crosstalk/inbox.jsonl"
