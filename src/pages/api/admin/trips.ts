import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  deleteTrip,
  getBotControl,
  listTrips,
  patchTrip,
  upsertTrip,
} from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.trips",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.trips");
    if (!allowed) return;

    if (req.method === "GET") {
      const search = asText(req.query.search);
      const status = asText(req.query.status);
      const limit = Number(req.query.limit || 200);

      const [trips, control] = await Promise.all([
        listTrips({
          search: search || undefined,
          status: status || undefined,
          limit: Number.isFinite(limit) ? limit : 200,
        }),
        getBotControl(),
      ]);

      return res.status(200).json({ ok: true, trips, control });
    }

    if (req.method === "POST") {
      const { id, fields } = req.body || {};
      if (!fields || typeof fields !== "object") {
        return res.status(400).json({ error: "fields object is required" });
      }
      const saved = await upsertTrip({
        id: typeof id === "string" ? id : undefined,
        fields,
      });
      if (!saved) return res.status(500).json({ error: "failed_to_save_trip" });
      return res.status(200).json({ ok: true, trip: saved });
    }

    if (req.method === "PATCH") {
      const { id, fields } = req.body || {};
      if (typeof id !== "string" || !id.trim()) {
        return res.status(400).json({ error: "id is required" });
      }
      if (!fields || typeof fields !== "object") {
        return res.status(400).json({ error: "fields object is required" });
      }
      const saved = await patchTrip(id.trim(), fields);
      if (!saved) return res.status(404).json({ error: "trip_not_found_or_no_changes" });
      return res.status(200).json({ ok: true, trip: saved });
    }

    if (req.method === "DELETE") {
      const id = asText(req.query.id) || asText((req.body || {}).id);
      if (!id) return res.status(400).json({ error: "id is required" });
      const deleted = await deleteTrip(id);
      if (!deleted) return res.status(404).json({ error: "trip_not_found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
