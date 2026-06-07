import { getEnv } from "./env";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";
import type { UpstreamTraceOptions } from "./messenger";

const env = getEnv();

export async function sendTextMessage(
  igUserId: string,
  recipientId: string,
  text: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  const startedAt = Date.now();
  const { attempts } = await fetchWithRetry(
    `https://graph.facebook.com/v19.0/${igUserId}/messages?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: recipientId },
        message: { text },
      }),
    },
    {
      upstream: "meta.instagram",
      timeoutMs: env.metaApiTimeoutMs,
      maxRetries: 0,
      retryBaseDelayMs: env.metaRetryBaseDelayMs,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      metricPrefix: "meta_api",
    },
  );

  logInfo("meta.instagram.request_success", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: trace?.source || "unknown",
    attempts,
    durationMs: Date.now() - startedAt,
  });
}
