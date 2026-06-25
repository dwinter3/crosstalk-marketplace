// crosstalk MCP — SQS send/receive/delete via the AWS CLI, using the Cognito-vended scoped creds.
// Mirrors the claude-mux sqs-cli-client approach (no @aws-sdk dep): the scoped creds are passed as
// env to `aws sqs …`. Requires AWS CLI v2 on the peer's machine (documented prereq).
//
// The message BODY is the crosstalk envelope (not a secret) so it may ride argv; the scoped creds
// ride the child env (not argv).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function credEnv(creds) {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
  };
}

/** Send to a FIFO queue. ContentBasedDeduplication is on, so no dedup id needed. */
export async function sendMessage({ region, queueUrl, body, groupId = "crosstalk", creds }) {
  const args = [
    "sqs", "send-message", "--region", region, "--queue-url", queueUrl,
    "--message-group-id", groupId, "--message-body", body, "--output", "json",
  ];
  const { stdout } = await execFileAsync("aws", args, { env: credEnv(creds), maxBuffer: 4 * 1024 * 1024 });
  return stdout && stdout.trim() ? JSON.parse(stdout) : {};
}

/** Receive up to `max` from the peer's own inbox (long-poll). */
export async function receiveMessages({ region, queueUrl, max = 5, waitSeconds = 2, creds }) {
  const args = [
    "sqs", "receive-message", "--region", region, "--queue-url", queueUrl,
    "--max-number-of-messages", String(max), "--wait-time-seconds", String(waitSeconds), "--output", "json",
  ];
  const { stdout } = await execFileAsync("aws", args, { env: credEnv(creds), maxBuffer: 8 * 1024 * 1024 });
  const j = stdout && stdout.trim() ? JSON.parse(stdout) : {};
  return Array.isArray(j.Messages) ? j.Messages : [];
}

/** Delete (ack) a received message so it doesn't redeliver. */
export async function deleteMessage({ region, queueUrl, receiptHandle, creds }) {
  const args = [
    "sqs", "delete-message", "--region", region, "--queue-url", queueUrl,
    "--receipt-handle", receiptHandle, "--output", "json",
  ];
  await execFileAsync("aws", args, { env: credEnv(creds), maxBuffer: 1024 * 1024 });
}
