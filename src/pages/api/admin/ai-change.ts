import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getClientKey, rateLimitAsync } from "../../../lib/rateLimit";
import {
  applyAIProposalDirect,
  applyAIRequest,
  generateAIProposal,
  getAIProposalFailureResponse,
  rollbackAIRequest,
  reviseAIRequest,
} from "../../../lib/travelOps";
import {
  beginRequestTrace,
  finishRequestTrace,
  recordCounter,
} from "../../../lib/observability";

export const config = {
  // Large pasted lists fan out into several batched AI calls; give the function
  // enough headroom to finish them (matches the file-parse endpoint and stays
  // above the 150s batch budget in generateAIProposalFromContentBatched).
  maxDuration: 180,
};

const ADMIN_AI_CHANGE_RATE_LIMIT = 30;
const ADMIN_AI_CHANGE_RATE_WINDOW_MS = 10 * 60 * 1000;
// Large pasted price lists are auto-split into batches in generateAIProposal,
// so allow a very generous instruction size here. The cap exists only to stop
// an absurd multi-MB paste from exhausting memory. Clarifications stay short.
const MAX_AI_CHANGE_INSTRUCTION_CHARS = 500_000;
const MAX_AI_CHANGE_CLARIFICATION_CHARS = 4_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.ai_change",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.ai_change");
    if (!allowed) return;

    if (req.method !== "POST") return res.status(405).end();

    const clientKey = getClientKey(req);
    const limit = await rateLimitAsync(
      `admin-ai:ai-change:${clientKey}`,
      ADMIN_AI_CHANGE_RATE_LIMIT,
      ADMIN_AI_CHANGE_RATE_WINDOW_MS,
    );
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.admin.ai_change",
        scope: "admin_ai",
      });
      return res.status(429).json({
        error: "rate_limited",
        reset: limit.reset,
        retry_after_ms: Math.max(0, limit.reset - Date.now()),
      });
    }

    const { instruction, request_id, apply, rollback, confirm, clarification, proposal_direct } =
      req.body || {};

    if (typeof request_id === "number" && rollback === true) {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to roll back stored AI change.",
        });
      }
      const rolledBack = await rollbackAIRequest(request_id);
      return res.status(rolledBack.ok ? 200 : 409).json(rolledBack);
    }

    // Apply a proposal that was never persisted to DB (request_id was null).
    if (apply === true && proposal_direct && typeof instruction === "string") {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to apply proposal.",
        });
      }
      const applied = await applyAIProposalDirect(proposal_direct, instruction.trim());
      return res.status(applied.ok ? 200 : 409).json(applied);
    }

    if (typeof request_id === "number" && apply === true) {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to apply stored AI proposal.",
        });
      }
      const applied = await applyAIRequest(request_id);
      return res.status(applied.ok ? 200 : 409).json(applied);
    }

    if (
      typeof request_id === "number" &&
      typeof clarification === "string" &&
      clarification.trim()
    ) {
      const trimmedClarification = clarification.trim();
      if (trimmedClarification.length > MAX_AI_CHANGE_CLARIFICATION_CHARS) {
        return res.status(413).json({
          error: "clarification_too_long",
          max_chars: MAX_AI_CHANGE_CLARIFICATION_CHARS,
        });
      }
      const revised = await reviseAIRequest(request_id, trimmedClarification);
      return res.status(revised.ok ? 200 : 409).json(revised);
    }

    if (typeof instruction !== "string" || !instruction.trim()) {
      return res.status(400).json({ error: "instruction is required" });
    }

    const trimmedInstruction = instruction.trim();
    if (trimmedInstruction.length > MAX_AI_CHANGE_INSTRUCTION_CHARS) {
      return res.status(413).json({
        error: "instruction_too_long",
        max_chars: MAX_AI_CHANGE_INSTRUCTION_CHARS,
      });
    }

    const proposal = await generateAIProposal(trimmedInstruction);
    const failure = getAIProposalFailureResponse(proposal.proposal);
    if (failure) {
      return res.status(failure.statusCode).json({
        ok: false,
        error: failure.error,
        retry_after_ms: failure.retry_after_ms,
        proposal: proposal.proposal,
        request_id: proposal.request_id,
      });
    }
    return res.status(200).json({
      ok: true,
      ...proposal,
      requires_confirmation: Boolean(proposal.proposal.needs_confirmation),
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
