import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  countNewLeads,
  getLeadStats,
  listLeads,
  markLeadSeen,
} from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.leads",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.leads");
    if (!allowed) return;

    if (req.method === "GET") {
      // ?stats=1 returns dashboard aggregates alongside the lead list.
      if (req.query.stats) {
        const [leads, newCount, stats] = await Promise.all([
          listLeads(80),
          countNewLeads(),
          getLeadStats(),
        ]);
        return res
          .status(200)
          .json({ ok: true, leads, new_count: newCount, stats });
      }
      const [leads, newCount] = await Promise.all([
        listLeads(80),
        countNewLeads(),
      ]);
      return res.status(200).json({ ok: true, leads, new_count: newCount });
    }

    if (req.method === "PATCH") {
      const { id } = req.body || {};
      const leadId = Number(id);
      if (!Number.isInteger(leadId) || leadId <= 0) {
        return res.status(400).json({ error: "valid id is required" });
      }
      const updated = await markLeadSeen(leadId);
      if (!updated) return res.status(404).json({ error: "lead_not_found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
