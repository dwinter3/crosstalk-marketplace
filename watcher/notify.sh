#!/usr/bin/env bash
# crosstalk-notify.sh — email notification for new crosstalk messages
# Triggered by systemd path unit when inbox.jsonl changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INBOX="$HOME/.crosstalk/inbox.jsonl"
STATE="$SCRIPT_DIR/state"
CONF="$SCRIPT_DIR/smtp.conf"
LAST_RUN="$SCRIPT_DIR/.last_run"

# ── Load config ───────────────────────────────────────────────────────────────
if [ ! -f "$CONF" ]; then
  echo "crosstalk-notify: missing $CONF — copy smtp.conf.template and fill in" >&2
  exit 1
fi
source "$CONF"

# ── Throttle ──────────────────────────────────────────────────────────────────
NOW=$(date +%s)
if [ -f "$LAST_RUN" ]; then
  PREV=$(cat "$LAST_RUN" 2>/dev/null || echo 0)
  ELAPSED=$(( NOW - PREV ))
  if [ "$ELAPSED" -lt "${MIN_INTERVAL:-60}" ]; then
    exit 0  # too soon, skip
  fi
fi

# ── Find new messages ─────────────────────────────────────────────────────────
if [ ! -f "$INBOX" ]; then
  exit 0
fi

# Load seen IDs (one per line)
declare -A SEEN
if [ -f "$STATE" ]; then
  while IFS= read -r id; do
    [ -n "$id" ] && SEEN["$id"]=1
  done < "$STATE"
fi

# Parse inbox.jsonl, collect new unread messages
NEW_MSGS=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  msg_id=$(echo "$line" | python3 -c "
import sys,json
try:
  m=json.loads(sys.stdin.readline())
  print(m.get('msg_id') or m.get('message_id') or m.get('id') or '')
except: pass
" 2>/dev/null)
  [ -z "$msg_id" ] && continue

  _read=$(echo "$line" | python3 -c "
import sys,json
try:
  m=json.loads(sys.stdin.readline())
  print(str(m.get('_read',False)).lower())
except: print('true')
" 2>/dev/null)
  [ "$_read" = "true" ] && continue  # skip already-read

  if [ -z "${SEEN[$msg_id]:-}" ]; then
    NEW_MSGS+=("$line")
    SEEN["$msg_id"]=1
  fi
done < "$INBOX"

# Update state file
for id in "${!SEEN[@]}"; do
  echo "$id"
done | sort > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

# ── No new messages? Done. ────────────────────────────────────────────────────
if [ ${#NEW_MSGS[@]} -eq 0 ]; then
  exit 0
fi

echo "$NOW" > "$LAST_RUN"

# ── Build email ───────────────────────────────────────────────────────────────
UNREAD_COUNT=$(python3 -c "
import sys,json
lines=open('$INBOX').read().strip().split('\n')
unread=[l for l in lines if l and not json.loads(l).get('_read',False)]
print(len(unread))
" 2>/dev/null || echo "${#NEW_MSGS[@]}")

SUBJECT="📬 Crosstalk: ${#NEW_MSGS[@]} new message(s) — $UNREAD_COUNT total unread"

BODY="You have ${#NEW_MSGS[@]} new crosstalk message(s) ($UNREAD_COUNT total unread).\n\n"
BODY+="──────────────────────────────────────────\n"
for msg in "${NEW_MSGS[@]}"; do
  parsed=$(echo "$msg" | python3 -c "
import sys,json
m=json.loads(sys.stdin.readline())
fr=m.get('from','?')
subj=m.get('subject','')
content=m.get('content','')[:300]
ts=m.get('ts','')
print(f'From:  {fr}')
if subj: print(f'Subj:  {subj}')
print(f'When:  {ts}')
print(f'{content}')
print('')
" 2>/dev/null)
  BODY+="$parsed\n──────────────────────────────────────────\n"
done

BODY+="\nRun /crosstalk-check or ask your AI to call check_inbox to read and reply."

# ── Send email via curl (SMTP with STARTTLS) ──────────────────────────────────
TMP_EMAIL=$(mktemp /tmp/crosstalk-email.XXXXXX)
trap "rm -f '$TMP_EMAIL'" EXIT

cat > "$TMP_EMAIL" <<EOF
From: Crosstalk Watcher <${SMTP_FROM}>
To: <${NOTIFY_TO}>
Subject: ${SUBJECT}
Date: $(date -R)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

$(echo -e "$BODY")
EOF

# Try curl first (works on most Linuxes with curl compiled against OpenSSL/GnuTLS)
# --ssl-reqd forces STARTTLS upgrade on port 587
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --url "smtp://${SMTP_HOST}:${SMTP_PORT}" \
  --ssl-reqd \
  --mail-from "${SMTP_FROM}" \
  --mail-rcpt "${NOTIFY_TO}" \
  --user "${SMTP_USER}:${SMTP_PASS}" \
  --upload-file "$TMP_EMAIL" \
  --connect-timeout 15 \
  --max-time 30 2>&1 || true)

# If curl failed, try Python fallback
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "250" ] && [ "$HTTP_CODE" != "0" ]; then
  python3 -c "
import smtplib, email.mime.text
with open('$TMP_EMAIL','r') as f:
    raw = f.read()
# Parse subject from raw
lines = raw.split('\n')
subject = ''
for l in lines:
    if l.lower().startswith('subject:'):
        subject = l.split(':',1)[1].strip()
        break

msg = email.mime.text.MIMEText(''.join(lines[lines.index('')+1:]) if '' in lines else raw, 'plain', 'utf-8')
msg['From'] = '${SMTP_FROM}'
msg['To'] = '${NOTIFY_TO}'
msg['Subject'] = subject

with smtplib.SMTP('${SMTP_HOST}', ${SMTP_PORT}) as s:
    s.starttls()
    s.login('${SMTP_USER}', '${SMTP_PASS}')
    s.send_message(msg)
print('sent-via-python')
" 2>&1 || {
    echo "crosstalk-notify: email failed (curl=$HTTP_CODE, python=error)" >&2
    exit 2
  }
fi

echo "crosstalk-notify: sent ${#NEW_MSGS[@]} notification(s) to ${NOTIFY_TO}" >&2
