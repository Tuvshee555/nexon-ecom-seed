import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  getDriveSyncDiagnostics,
  runDriveFolderSync,
} from "../../../lib/googleDriveSync";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.drive_sync",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.drive_sync");
    if (!allowed) return;

    if (req.method === "GET") {
      const diagnostics = await getDriveSyncDiagnostics();
      return res.status(200).json({ ok: true, diagnostics });
    }

    if (req.method === "POST") {
      const result = await runDriveFolderSync({
        force: true,
        source: "api.admin.drive_sync",
      });
      return res.status(result.ok ? 200 : 409).json(result);
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
