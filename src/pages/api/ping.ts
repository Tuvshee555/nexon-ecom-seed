import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../lib/env";
import { pickFirst, safeSecretCompare } from "../../lib/adminAuth";
import { getReadinessReport } from "../../lib/readiness";
import {
  beginRequestTrace,
  finishRequestTrace,
  getObservabilityDiagnostics,
  metricsSummary,
} from "../../lib/observability";
import { getCircuitState } from "../../lib/resilience";
import { getRedisHealth } from "../../lib/redisState";

const env = getEnv();

function hasAdminAccess(req: NextApiRequest): boolean {
  const provided = pickFirst(req.headers["x-admin-secret"] as string | string[] | undefined);
  return safeSecretCompare(env.adminSecret, provided);
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.ping",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method !== "GET") return res.status(405).end();

    const basic = {
      ok: true,
      now: new Date().toISOString(),
    };

    if (hasAdminAccess(req)) {
      return res.status(200).json({
        ...basic,
        vercel: Boolean(process.env.VERCEL),
        env: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
        sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
        metrics: metricsSummary(),
        observability: getObservabilityDiagnostics(),
        readiness: getReadinessReport(env),
        circuit: {
          gemini: getCircuitState("gemini.generateContent"),
        },
        redis: getRedisHealth(),
      });
    }

    return res.status(200).json(basic);
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
