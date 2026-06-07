/* eslint-disable @typescript-eslint/no-explicit-any */
import { getEnv } from "./env";
import { recordCounter } from "./observability";
import { withRedis } from "./redisState";
import { buildTemporalPromptContext } from "./travelDates";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  text: string;
};

type ChatSession = {
  messages: ChatMessage[];
  updatedAt: number;
};

const STORE = new Map<string, ChatSession>();
const env = getEnv();
const MAX_MESSAGES = 12;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = env.conversationMaxSessions;
const CONVERSATION_INDEX_KEY = "conversation:index";

function conversationListKey(id: string) {
  return `conversation:messages:${id}`;
}

function prune() {
  const now = Date.now();
  for (const [key, session] of STORE.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) STORE.delete(key);
  }

  const overflow = STORE.size - MAX_SESSIONS;
  if (overflow <= 0) return;

  const oldest = Array.from(STORE.entries())
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    STORE.delete(key);
  }
}

export async function getHistory(id: string): Promise<ChatMessage[]> {
  if (env.redisConversationEnabled) {
    const redisHistory = await withRedis("conversation.get_history", async (redis) => {
      const raw = await redis.lrange(conversationListKey(id), -MAX_MESSAGES, -1);
      if (!raw.length) {
        await redis.zrem(CONVERSATION_INDEX_KEY, id);
        return [] as ChatMessage[];
      }
      const parsed: ChatMessage[] = [];
      for (const entry of raw) {
        try {
          const message = JSON.parse(entry) as ChatMessage;
          if (
            (message.role === "user" || message.role === "assistant") &&
            typeof message.text === "string"
          ) {
            parsed.push(message);
          }
        } catch {
          // Drop malformed entries to prevent runtime crashes.
        }
      }
      return parsed;
    });

    if (redisHistory) return redisHistory;
    recordCounter("conversation.redis_fallback_total", 1, {
      operation: "getHistory",
    });
  }

  prune();
  return STORE.get(id)?.messages || [];
}

export async function appendMessage(id: string, role: ChatRole, text: string) {
  if (env.redisConversationEnabled) {
    const redisApplied = await withRedis("conversation.append_message", async (redis) => {
      const now = Date.now();
      const key = conversationListKey(id);
      const payload = JSON.stringify({ role, text });
      const pipeline = redis.pipeline();
      pipeline.rpush(key, payload);
      pipeline.ltrim(key, -MAX_MESSAGES, -1);
      pipeline.pexpire(key, SESSION_TTL_MS);
      pipeline.zadd(CONVERSATION_INDEX_KEY, now, id);
      const execResult = await pipeline.exec();
      if (!execResult) return false;

      const total = await redis.zcard(CONVERSATION_INDEX_KEY);
      if (total > MAX_SESSIONS) {
        const overflow = total - MAX_SESSIONS;
        const oldest = await redis.zrange(CONVERSATION_INDEX_KEY, 0, overflow - 1);
        if (oldest.length) {
          const eviction = redis.pipeline();
          for (const sessionId of oldest) {
            eviction.zrem(CONVERSATION_INDEX_KEY, sessionId);
            eviction.del(conversationListKey(sessionId));
          }
          await eviction.exec();
        }
      }
      return true;
    });

    if (redisApplied) return;
    recordCounter("conversation.redis_fallback_total", 1, {
      operation: "appendMessage",
    });
  }

  prune();
  const session = STORE.get(id) || { messages: [], updatedAt: Date.now() };
  session.messages.push({ role, text });

  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }

  session.updatedAt = Date.now();
  STORE.set(id, session);
}

export function buildPrompt(options: {
  systemPrompt: string;
  business: {
    name?: string;
    knowledgeBase?: any;
  };
  history: ChatMessage[];
  userText: string;
}) {
  const { systemPrompt, business, history, userText } = options;
  const lines: string[] = [];

  const recentHistory = history.slice(-6);

  lines.push(systemPrompt.trim());
  lines.push("");

  lines.push("Reply rules:");
  lines.push("- ALWAYS reply in Mongolian only. Even if the user writes in English or mixes languages, reply fully in Mongolian.");
  lines.push("- Be warm, natural, and conversational.");
  lines.push("- Keep replies short (2-4 sentences max). Avoid repeating yourself.");
  lines.push("- Use only the provided context. Do not invent routes, prices, departure dates, operators, or visa details.");
  lines.push("- NEVER use markdown formatting. Reply as plain text only.");
  lines.push("- Resolve relative date words using the Time context. Do not ask what date 'маргааш', 'margaash', or 'tomorrow' means.");
  lines.push("- If the user asks whether a trip departs on a resolved date, answer yes/no from departure dates in Context. If no exact match exists, say no and optionally mention nearby listed dates.");
  lines.push("- If the user asks for exact үнэ/өдөр, quote it from the dataset as-is.");
  lines.push("- If the same route has different prices between operators, mention that operator prices differ and ask which operator they want.");
  lines.push("- If information is missing or ambiguous, clearly say it is not confirmed in the current dataset.");
  lines.push("- If the user message is unclear, ask ONE short clarifying question.");
  lines.push("- Stay travel-topic focused and politely redirect unrelated questions.");

  lines.push("");
  lines.push(`Business name: ${business?.name || "N/A"}`);

  lines.push("Time context:");
  lines.push(buildTemporalPromptContext(userText));
  lines.push("");

  lines.push("Context:");

  if (typeof business?.knowledgeBase === "string") {
    lines.push(business.knowledgeBase);
  } else {
    lines.push(JSON.stringify(business?.knowledgeBase || {}));
  }

  lines.push("");

  if (recentHistory.length) {
    lines.push("Conversation so far:");
    for (const message of recentHistory) {
      const role = message.role === "user" ? "User" : "Assistant";
      lines.push(`${role}: ${message.text}`);
    }
    lines.push("");
  }

  lines.push(`User: ${userText}`);
  lines.push("Assistant:");

  return lines.join("\n");
}
