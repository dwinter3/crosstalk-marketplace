#!/usr/bin/env bash
# setup-debian.sh — one-command setup for crosstalk email watcher on Debian
# Usage:  curl -sL <raw-url> | bash -s -- <private-repo-url>
#    or:  bash setup-debian.sh git@github.com:you/crosstalk-watcher.git
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  echo -e "${RED}Usage: bash setup-debian.sh <git-repo-url>${NC}"
  echo "  Example: bash setup-debian.sh git@github.com:you/crosstalk-watcher.git"
  exit 1
fi

echo -e "${GREEN}=== crosstalk email watcher — Debian setup ===${NC}"
echo ""

# ── Check system ──────────────────────────────────────────────────────────────
if ! command -v systemctl &>/dev/null; then
  echo -e "${RED}ERROR: systemd not found. This watcher requires systemd.${NC}"
  exit 1
fi

# ── Install deps ──────────────────────────────────────────────────────────────
echo "→ Checking dependencies..."
MISSING=""
for dep in git curl python3; do
  if ! command -v "$dep" &>/dev/null; then
    MISSING="$MISSING $dep"
  fi
done

if [ -n "$MISSING" ]; then
  echo "→ Installing: $MISSING"
  sudo apt-get update -qq
  sudo apt-get install -y -qq $MISSING
fi
echo -e "  ${GREEN}✓${NC} Dependencies OK"

# ── Ensure user systemd directory exists ─────────────────────────────────────
mkdir -p ~/.config/systemd/user

# ── Clone repo ────────────────────────────────────────────────────────────────
WATCHER_DIR="$HOME/.crosstalk/watcher"
if [ -d "$WATCHER_DIR/.git" ]; then
  echo "→ Repo exists at $WATCHER_DIR, pulling latest..."
  git -C "$WATCHER_DIR" pull --ff-only
else
  echo "→ Cloning from $REPO_URL..."
  git clone "$REPO_URL" "$WATCHER_DIR"
fi
echo -e "  ${GREEN}✓${NC} Repo ready"

# ── Run install ───────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}=== Running install.sh ===${NC}"
echo ""

bash "$WATCHER_DIR/install.sh"

echo ""
echo -e "${GREEN}=== Done ===${NC}"
echo ""
echo -e "Next steps:"
echo -e "  ${YELLOW}1. Edit your email credentials:${NC}"
echo "     nano ~/.crosstalk/watcher/smtp.conf"
echo ""
echo -e "  ${YELLOW}2. Re-run install after editing:${NC}"
echo "     bash ~/.crosstalk/watcher/install.sh"
echo ""
echo -e "  ${YELLOW}3. Check status anytime:${NC}"
echo "     systemctl --user status crosstalk-notify.path"
echo "     journalctl --user -u crosstalk-notify.service -f"
