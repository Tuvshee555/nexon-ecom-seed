import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "./env";
import { pickFirst, safeSecretCompare } from "./adminAuth";
import { getClientKey, rateLimitAsync } from "./rateLimit";
import { recordCounter } from "./observability";

const env = getEnv();

function extractProvidedSecret(req: NextApiRequest): string {
  const headerSecret = pickFirst(
    req.headers["x-admin-secret"] as string | string[] | undefined,
  );
  const querySecret = env.allowAdminSecretQuery
    ? pickFirst(req.query.secret as string | string[] | undefined)
    : "";
  return headerSecret || querySecret;
}

export function hasAdminAccess(req: NextApiRequest): boolean {
  if (env.adminOpenAccess) return true;
  const providedSecret = extractProvidedSecret(req);
  return safeSecretCompare(env.adminSecret, providedSecret);
}

export async function requireAdminAccess(
  req: NextApiRequest,
  res: NextApiResponse,
  route: string,
) {
  if (hasAdminAccess(req)) return true;

  const clientKey = getClientKey(req);
  const limit = await rateLimitAsync(
    `admin-auth:${clientKey}`,
    env.adminAuthRateLimit,
    60 * 1000,
  );
  if (!limit.allowed) {
    recordCounter("abuse.admin_auth_blocked_total", 1, { route });
    res.status(429).json({ error: "too_many_attempts", reset: limit.reset });
    return false;
  }

  recordCounter("abuse.admin_auth_failed_total", 1, { route });
  res.status(401).json({ error: "unauthorized" });
  return false;
}
