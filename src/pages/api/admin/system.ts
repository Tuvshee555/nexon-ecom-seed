import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../lib/env";
import { hasAdminAccess } from "../../../lib/adminAccess";
import {
  getDriveSyncDiagnostics,
  maybeAutoSyncDriveFolder,
} from "../../../lib/googleDriveSync";
import { getDbDiagnostics } from "../../../lib/travelOps";
import { getReadinessReport } from "../../../lib/readiness";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

const env = getEnv();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.system",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method !== "GET") return res.status(405).end();

    const authorized = hasAdminAccess(req);
    if (!authorized) {
      return res.status(200).json({
        ok: true,
        open_access: env.adminOpenAccess,
        authorized: false,
      });
    }

    void maybeAutoSyncDriveFolder({ source: "api.admin.system" });
    const [diagnostics, driveSync] = await Promise.all([
      getDbDiagnostics(),
      getDriveSyncDiagnostics(),
    ]);
    return res.status(200).json({
      ok: true,
      open_access: env.adminOpenAccess,
      authorized: true,
      db: diagnostics,
      drive_sync: driveSync,
      readiness: getReadinessReport(env),
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
