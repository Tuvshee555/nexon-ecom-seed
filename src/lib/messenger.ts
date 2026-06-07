import { getEnv } from "./env";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";

const env = getEnv();

export type UpstreamTraceOptions = {
  requestId?: string;
  correlationId?: string;
  source?: string;
};

async function postToMessenger(
  endpoint: string,
  body: Record<string, unknown>,
  trace?: UpstreamTraceOptions,
) {
  const startedAt = Date.now();
  const { attempts } = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    {
      upstream: "meta.messenger",
      timeoutMs: env.metaApiTimeoutMs,
      maxRetries: 0,
      retryBaseDelayMs: env.metaRetryBaseDelayMs,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      metricPrefix: "meta_api",
    },
  );
  logInfo("meta.messenger.request_success", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: trace?.source || "unknown",
    attempts,
    durationMs: Date.now() - startedAt,
  });
}

export async function sendTextMessage(
  recipientId: string,
  text: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text },
    },
    trace,
  );
}

export async function replyToComment(
  commentId: string,
  message: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/${commentId}/comments?access_token=${token}`,
    { message },
    trace,
  );
}

export async function sendTypingOn(
  recipientId: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    },
    trace,
  );
}
