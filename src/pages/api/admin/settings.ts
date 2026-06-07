import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  getTravelBotSettings,
  updateTravelBotSettings,
} from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.settings",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.settings");
    if (!allowed) return;

    if (req.method === "GET") {
      const settings = await getTravelBotSettings();
      return res.status(200).json({ ok: true, settings });
    }

    if (req.method === "PATCH") {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const fields =
        body && typeof body.fields === "object" && body.fields
          ? body.fields
          : body;
      if (!fields || typeof fields !== "object") {
        return res.status(400).json({ error: "fields object is required" });
      }

      const settings = await updateTravelBotSettings(
        fields as Parameters<typeof updateTravelBotSettings>[0],
      );
      return res.status(200).json({ ok: true, settings });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
