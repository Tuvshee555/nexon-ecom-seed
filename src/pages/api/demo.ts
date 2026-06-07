/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NextApiRequest, NextApiResponse } from "next";
import { askGemini } from "../../lib/gemini";
import {
  buildShardedRateLimitKey,
  getClientKey,
  rateLimitAsync,
} from "../../lib/rateLimit";
import { readBusinessData } from "../../lib/businessData";
import { appendMessage, buildPrompt, getHistory } from "../../lib/conversation";
import { fixMojibake } from "../../lib/encoding";
import { maybeAutoSyncDriveFolder } from "../../lib/googleDriveSync";
import { enforceWebsiteForPayment, sanitizeAssistantReply } from "../../lib/reply";
import { getEnv } from "../../lib/env";
import {
  beginRequestTrace,
  classifyError,
  finishRequestTrace,
  hashIdentifier,
  logError,
  logInfo,
  recordCounter,
} from "../../lib/observability";

const env = getEnv();
const DEMO_MAX_TEXT_CHARS = env.demoMaxTextChars;
const DEMO_GLOBAL_LIMIT = env.demoGlobalRateLimit;
const DEMO_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{16,80}$/;

function normalizeConversationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DEMO_CONVERSATION_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const trace = beginRequestTrace({
    route: "api.demo",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method !== "POST") {
      return res.status(405).end();
    }

    const { text, conversationId } = req.body || {};
    if (typeof text !== "string") return res.status(400).json({ error: "missing text" });

    const normalizedText = text.trim();
    if (!normalizedText) return res.status(400).json({ error: "missing text" });
    if (normalizedText.length > DEMO_MAX_TEXT_CHARS) {
      return res.status(413).json({ error: "text_too_long", max: DEMO_MAX_TEXT_CHARS });
    }

    const clientKey = getClientKey(req);
    const clientHash = hashIdentifier(clientKey);
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) {
      return res.status(400).json({ error: "invalid_conversation_id" });
    }

    const key = `demo:${clientKey}`;
    const limit = await rateLimitAsync(key, 30, 5 * 60 * 1000); // 30 requests per 5 minutes per IP
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.demo",
        scope: "client",
      });
      return res.status(429).json({
        error: "rate_limited",
        reset: limit.reset,
      });
    }

    const shardKey = buildShardedRateLimitKey("demo:global", clientKey, 32);
    const shardLimit = await rateLimitAsync(
      shardKey,
      DEMO_GLOBAL_LIMIT,
      60 * 1000,
    );
    if (!shardLimit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.demo",
        scope: "global_shard",
      });
      return res.status(429).json({
        error: "server_busy",
        reset: shardLimit.reset,
      });
    }

    const globalLimit = await rateLimitAsync(
      "demo:global:all",
      DEMO_GLOBAL_LIMIT * 32,
      60 * 1000,
    );
    if (!globalLimit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.demo",
        scope: "global_all",
      });
      return res.status(429).json({
        error: "server_busy",
        reset: globalLimit.reset,
      });
    }

    try {
      void maybeAutoSyncDriveFolder({ source: "api.demo" });
      const { systemPrompt, business } = await readBusinessData();
      const sessionId = `demo:${normalizedConversationId}`;
      const history = await getHistory(sessionId);

      const prompt = buildPrompt({
        systemPrompt,
        business: business || {},
        history,
        userText: normalizedText,
      });
      const result = await askGemini(prompt, {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        source: "api.demo",
      });
      const reply = enforceWebsiteForPayment(
        sanitizeAssistantReply(fixMojibake(result.text)),
      );
      await appendMessage(sessionId, "user", normalizedText);
      await appendMessage(sessionId, "assistant", reply);

      logInfo("demo.reply_generated", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        clientHash,
        conversationIdSuffix: normalizedConversationId.slice(-8),
        promptLength: prompt.length,
        replyLength: reply.length,
      });

      return res.status(200).json({ reply });
    } catch (error: any) {
      const classification = classifyError(error);
      logError("demo.request_failed", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        classification,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: "server_error" });
    }
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
