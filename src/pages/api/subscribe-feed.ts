import type { NextApiRequest, NextApiResponse } from "next";
import { getClientKey, rateLimitAsync } from "../../lib/rateLimit";
import { getEnv } from "../../lib/env";
import { pickFirst, safeSecretCompare } from "../../lib/adminAuth";
import {
  beginRequestTrace,
  classifyError,
  finishRequestTrace,
  hashIdentifier,
  logError,
  recordCounter,
} from "../../lib/observability";
import { fetchWithRetry } from "../../lib/resilience";

const env = getEnv();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.subscribe_feed",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  const clientKey = getClientKey(req);

  try {
    const headerSecret = pickFirst(req.headers["x-admin-secret"]);
    const querySecret = env.allowAdminSecretQuery ? pickFirst(req.query.secret) : "";
    const providedSecret = headerSecret || querySecret;

    if (!safeSecretCompare(env.adminSecret, providedSecret)) {
      const limit = await rateLimitAsync(
        `admin-auth:${clientKey}`,
        env.adminAuthRateLimit,
        60 * 1000,
      );
      if (!limit.allowed) {
        recordCounter("abuse.admin_auth_blocked_total", 1, {
          route: "api.subscribe_feed",
        });
        return res.status(429).json({ error: "too_many_attempts", reset: limit.reset });
      }
      recordCounter("abuse.admin_auth_failed_total", 1, {
        route: "api.subscribe_feed",
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const fields = "feed,messages,messaging_postbacks,message_reads";
    const url = `https://graph.facebook.com/v19.0/${env.facebookPageId}/subscribed_apps`;

    try {
      const { response, attempts, durationMs } = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscribed_fields: fields,
            access_token: env.tokenPage,
          }),
        },
        {
          upstream: "meta.subscribe_feed",
          timeoutMs: env.metaApiTimeoutMs,
          maxRetries: env.metaSubscribeMaxRetries,
          retryBaseDelayMs: env.metaRetryBaseDelayMs,
          requestId: trace.requestId,
          correlationId: trace.correlationId,
          metricPrefix: "meta_api",
        },
      );

      const body = await response.json();
      return res.status(200).json({
        success: true,
        subscribed_fields: fields,
        response: body,
        attempts,
        duration_ms: durationMs,
      });
    } catch (error) {
      const classification = classifyError(error);
      logError("subscribe_feed.failed", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        classification,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({ error: "upstream_error", classification });
    }
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {
      clientHash: hashIdentifier(clientKey),
    });
  }
}
