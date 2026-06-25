// crosstalk MCP — SQS send/receive/delete via the AWS SDK (no AWS CLI dependency), using the
// Cognito-vended scoped creds. The message BODY is the crosstalk envelope (not a secret); the scoped
// creds are passed to the SDK client in-process (never argv).

import {
  SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

function client(region, creds) {
  return new SQSClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/** Send to a FIFO queue. ContentBasedDeduplication is on, so no dedup id needed. */
export async function sendMessage({ region, queueUrl, body, groupId = "crosstalk", creds }) {
  const r = await client(region, creds).send(new SendMessageCommand({
    QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId,
  }));
  return { MessageId: r.MessageId };
}

/** Receive up to `max` from the peer's own inbox (long-poll). */
export async function receiveMessages({ region, queueUrl, max = 5, waitSeconds = 2, creds }) {
  const r = await client(region, creds).send(new ReceiveMessageCommand({
    QueueUrl: queueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: waitSeconds,
  }));
  return Array.isArray(r.Messages) ? r.Messages : [];
}

/** Delete (ack) a received message so it doesn't redeliver. */
export async function deleteMessage({ region, queueUrl, receiptHandle, creds }) {
  await client(region, creds).send(new DeleteMessageCommand({
    QueueUrl: queueUrl, ReceiptHandle: receiptHandle,
  }));
}
