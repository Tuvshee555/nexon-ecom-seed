import type { NextApiRequest, NextApiResponse } from "next";
import {
  isPaused,
  listPaused,
  listRecent,
  pauseBot,
  resumeBot,
} from "../../lib/pause";
import { getClientKey } from "../../lib/rateLimit";
import { requireAdminAccess } from "../../lib/adminAccess";
import { getBotControl, setBotPaused } from "../../lib/travelOps";
import {
  beginRequestTrace,
  finishRequestTrace,
  hashIdentifier,
} from "../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.pause",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const access = await requireAdminAccess(req, res, "api.pause");
    if (!access) return;

    if (req.method === "GET") {
      return res.status(200).json({
        paused: await listPaused(),
        recent: await listRecent(),
        control: await getBotControl(),
      });
    }

    if (req.method === "POST") {
      const { sender_id, action, duration_ms, reason } = req.body || {};

      if (action === "global_pause") {
        await setBotPaused(true, typeof reason === "string" ? reason : null);
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }
      if (action === "global_resume") {
        await setBotPaused(false, null);
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }
      if (action === "global_status") {
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }

      if (!sender_id) return res.status(400).json({ error: "missing sender_id" });

      if (action === "pause") {
        await pauseBot(
          sender_id,
          typeof duration_ms === "number" ? duration_ms : undefined,
        );
        return res.status(200).json({ ok: true, sender_id, paused: true });
      }
      if (action === "resume") {
        await resumeBot(sender_id);
        return res.status(200).json({ ok: true, sender_id, paused: false });
      }
      if (action === "status") {
        return res.status(200).json({ sender_id, paused: await isPaused(sender_id) });
      }

      return res.status(400).json({
        error:
          "action must be pause | resume | status | global_pause | global_resume | global_status",
      });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {
      clientHash: hashIdentifier(getClientKey(req)),
    });
  }
}
