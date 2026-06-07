import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../lib/env";
import { pickFirst, safeSecretCompare } from "../../lib/adminAuth";
import {
  beginRequestTrace,
  finishRequestTrace,
  getMetricsSnapshot,
  getObservabilityDiagnostics,
} from "../../lib/observability";
import { getRedisHealth } from "../../lib/redisState";
import { getRateLimitDiagnostics } from "../../lib/rateLimit";
import { getWebhookRuntimeDiagnostics } from "./webhook";

const env = getEnv();

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.metrics",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method !== "GET") return res.status(405).end();

    const secret = pickFirst(req.headers["x-admin-secret"]);
    if (!safeSecretCompare(env.adminSecret, secret)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      metrics: getMetricsSnapshot(),
      diagnostics: {
        observability: getObservabilityDiagnostics(),
        redis: getRedisHealth(),
        rateLimit: getRateLimitDiagnostics(),
        webhook: getWebhookRuntimeDiagnostics(),
      },
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}

