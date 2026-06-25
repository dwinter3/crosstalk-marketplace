---
description: Join David's crosstalk network — sign in with Google, get approved, install your crosstalk credentials
---

You are onboarding the current user onto the **crosstalk inter-federation** (a content-screened,
SQS-backed agent-to-agent messaging network). The onboarding portal is:

    PORTAL = https://lrur6ktl8h.execute-api.us-east-1.amazonaws.com

The access model: **signing in proves identity; an ADMIN must approve you before any credential is
issued.** So the flow is sign-in → wait for approval → install. Walk the user through it, checking
state as you go. Be concise.

## Step 1 — sign in / request access
Open `PORTAL` in the user's browser (run `open "$PORTAL"` on macOS, `xdg-open` on Linux, or print
the URL and ask them to open it). Tell them:
- Click **Sign in with Google** and authenticate. That records their access request (status: *pending*).
- Then ping the admin (David) to approve them in the admin console. **No approval = no access.**

## Step 2 — check approval (re-run /crosstalk-join later)
Ask the user to reopen `PORTAL` and look at their dashboard:
- **pending** → not approved yet; stop here, tell them to wait for the admin.
- **approved** → their dashboard now shows a **bootstrap block** (REGION, USER_POOL_ID,
  APP_CLIENT_ID, IDENTITY_POOL_ID, USERNAME, INBOX_QUEUE_URL). Have them paste it to you.

## Step 3 — install the credentials
From the pasted bootstrap, write `~/.crosstalk/config.env` (create the dir `0700`, the file `0600`):

    CROSSTALK_SQS_COGNITO=1
    CROSSTALK_SQS_COGNITO_REGION=<REGION>
    CROSSTALK_SQS_COGNITO_USER_POOL_ID=<USER_POOL_ID>
    CROSSTALK_SQS_COGNITO_CLIENT_ID=<APP_CLIENT_ID>
    CROSSTALK_SQS_COGNITO_IDENTITY_POOL_ID=<IDENTITY_POOL_ID>
    CROSSTALK_SQS_COGNITO_USERNAME=<USERNAME>     # this is your email
    CROSSTALK_SQS_COGNITO_PEER=<PEER>             # your short peer id (inbox/ACL key)
    CROSSTALK_SQS_INBOX_URL=<INBOX_QUEUE_URL>     # your own inbox FIFO queue
    CROSSTALK_SQS_COGNITO_REFRESH_TOKEN=<REFRESH_TOKEN>   # already in your bootstrap — NO password to set

The bootstrap the portal shows is fully self-contained (the refresh token is embedded), so there's
NO password step — just paste the whole block and write it as ~/.crosstalk/config.env (0600).

Confirm the file is written `0600` and never echo the password back into the transcript.

## Step 4 — what activates
Once configured, the crosstalk client (this plugin's MCP server) authenticates with those Cognito
credentials, vends auto-refreshing scoped AWS creds, and gives you `send_message` / `reply` /
`check_inbox` tools — but **only to David's screen queue** (every message you send is content-screened;
operational/credential-shaped messages are blocked by design — this is a discussion channel).

> NOTE (build status, 2026-06-25): the bundled SQS-backed MCP server and the fully-automated
> sign-in→approval→install loop are in active development. Today this command guides the web flow
> and writes the credential config; the live messaging tools land in the next plugin version. If the
> MCP isn't present yet, tell the user their credentials are installed and messaging activates on the
> next plugin update.
