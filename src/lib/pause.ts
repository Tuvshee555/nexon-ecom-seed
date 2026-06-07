import { getEnv } from "./env";
import { recordCounter } from "./observability";
import { withRedis } from "./redisState";

export type PausedRow = {
  sender_id: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};
export type RecentSender = { sender_id: string; last_seen: string };

const env = getEnv();
const pausedSenders = new Map<
  string,
  { paused_at: string; expires_at: string | null; reason?: string }
>();
const recentSenders = new Map<string, string>(); // sender_id → last_seen ISO
const MAX_RECENT = 20;
const MAX_PAUSED_SENDERS = env.pauseMaxSenders;

function isExpired(row: { expires_at: string | null }): boolean {
  if (!row.expires_at) return false;
  return new Date(row.expires_at) < new Date();
}

function pausedKey(senderId: string) {
  return `pause:sender:${senderId}`;
}

const PAUSED_INDEX_KEY = "pause:index";
const RECENT_SENDERS_KEY = "pause:recent_senders";

async function redisIsPaused(senderId: string): Promise<boolean | null> {
  const result = await withRedis("pause.is_paused", async (redis) => {
    const raw = await redis.get(pausedKey(senderId));
    if (!raw) return false;
    const row = JSON.parse(raw) as { paused_at: string; expires_at: string | null };
    if (isExpired(row)) {
      await redis.del(pausedKey(senderId));
      await redis.zrem(PAUSED_INDEX_KEY, senderId);
      return false;
    }
    return true;
  });
  return result;
}

export async function isPaused(senderId: string): Promise<boolean> {
  if (env.redisPauseEnabled) {
    const redisResult = await redisIsPaused(senderId);
    if (typeof redisResult === "boolean") return redisResult;
    recordCounter("pause.redis_fallback_total", 1, { operation: "isPaused" });
  }

  const row = pausedSenders.get(senderId);
  if (!row) return false;
  if (isExpired(row)) {
    pausedSenders.delete(senderId);
    return false;
  }
  return true;
}

export async function pauseBot(
  senderId: string,
  durationMs?: number,
  reason?: string,
): Promise<void> {
  if (env.redisPauseEnabled) {
    const now = Date.now();
    const paused_at = new Date(now).toISOString();
    const expires_at = durationMs ? new Date(now + durationMs).toISOString() : null;
    const redisApplied = await withRedis("pause.pause_bot", async (redis) => {
      const payload = JSON.stringify({ paused_at, expires_at, reason });
      if (durationMs && durationMs > 0) {
        await redis.psetex(pausedKey(senderId), durationMs, payload);
      } else {
        await redis.set(pausedKey(senderId), payload);
      }
      await redis.zadd(PAUSED_INDEX_KEY, now, senderId);

      const count = await redis.zcard(PAUSED_INDEX_KEY);
      if (count > MAX_PAUSED_SENDERS) {
        const overflow = count - MAX_PAUSED_SENDERS;
        const oldest = await redis.zrange(PAUSED_INDEX_KEY, 0, overflow - 1);
        if (oldest.length) {
          const pipeline = redis.pipeline();
          for (const id of oldest) {
            pipeline.zrem(PAUSED_INDEX_KEY, id);
            pipeline.del(pausedKey(id));
          }
          await pipeline.exec();
        }
      }
      return true;
    });

    if (redisApplied) return;
    recordCounter("pause.redis_fallback_total", 1, { operation: "pauseBot" });
  }

  if (!pausedSenders.has(senderId) && pausedSenders.size >= MAX_PAUSED_SENDERS) {
    for (const [id, row] of pausedSenders.entries()) {
      if (isExpired(row)) pausedSenders.delete(id);
    }

    if (pausedSenders.size >= MAX_PAUSED_SENDERS) {
      const oldest = Array.from(pausedSenders.entries())
        .sort((a, b) => a[1].paused_at.localeCompare(b[1].paused_at))[0];
      if (oldest) pausedSenders.delete(oldest[0]);
    }
  }

  const paused_at = new Date().toISOString();
  const expires_at = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
  pausedSenders.set(senderId, { paused_at, expires_at, reason });
}

export async function resumeBot(senderId: string): Promise<void> {
  if (env.redisPauseEnabled) {
    const redisApplied = await withRedis("pause.resume_bot", async (redis) => {
      await redis.del(pausedKey(senderId));
      await redis.zrem(PAUSED_INDEX_KEY, senderId);
      return true;
    });
    if (redisApplied) return;
    recordCounter("pause.redis_fallback_total", 1, { operation: "resumeBot" });
  }

  pausedSenders.delete(senderId);
}

export async function listPaused(): Promise<PausedRow[]> {
  if (env.redisPauseEnabled) {
    const redisRows = await withRedis("pause.list_paused", async (redis) => {
      const senderIds = await redis.zrevrange(PAUSED_INDEX_KEY, 0, MAX_PAUSED_SENDERS - 1);
      if (!senderIds.length) return [] as PausedRow[];

      const rowsRaw = await redis.mget(senderIds.map((id) => pausedKey(id)));
      const rows: PausedRow[] = [];
      const staleIds: string[] = [];

      senderIds.forEach((sender_id, index) => {
        const payload = rowsRaw[index];
        if (!payload) {
          staleIds.push(sender_id);
          return;
        }

        try {
          const parsed = JSON.parse(payload) as {
            paused_at: string;
            expires_at: string | null;
            reason?: string;
          };
          if (isExpired(parsed)) {
            staleIds.push(sender_id);
            return;
          }
          rows.push({
            sender_id,
            paused_at: parsed.paused_at,
            expires_at: parsed.expires_at,
            reason: parsed.reason,
          });
        } catch {
          staleIds.push(sender_id);
        }
      });

      if (staleIds.length) {
        const pipeline = redis.pipeline();
        for (const sender_id of staleIds) {
          pipeline.zrem(PAUSED_INDEX_KEY, sender_id);
          pipeline.del(pausedKey(sender_id));
        }
        await pipeline.exec();
      }
      return rows.sort((a, b) => b.paused_at.localeCompare(a.paused_at));
    });

    if (redisRows) return redisRows;
    recordCounter("pause.redis_fallback_total", 1, { operation: "listPaused" });
  }

  const result: PausedRow[] = [];
  for (const [sender_id, row] of pausedSenders.entries()) {
    if (isExpired(row)) {
      pausedSenders.delete(sender_id);
      continue;
    }
    result.push({
      sender_id,
      paused_at: row.paused_at,
      expires_at: row.expires_at,
      reason: row.reason,
    });
  }
  return result.sort((a, b) => b.paused_at.localeCompare(a.paused_at));
}

export async function trackSender(senderId: string): Promise<void> {
  if (env.redisPauseEnabled) {
    const redisApplied = await withRedis("pause.track_sender", async (redis) => {
      const now = Date.now();
      await redis.zadd(RECENT_SENDERS_KEY, now, senderId);
      const count = await redis.zcard(RECENT_SENDERS_KEY);
      if (count > MAX_RECENT) {
        await redis.zremrangebyrank(RECENT_SENDERS_KEY, 0, count - MAX_RECENT - 1);
      }
      return true;
    });

    if (redisApplied) return;
    recordCounter("pause.redis_fallback_total", 1, { operation: "trackSender" });
  }

  recentSenders.set(senderId, new Date().toISOString());
  if (recentSenders.size > MAX_RECENT) {
    const oldest = Array.from(recentSenders.entries()).sort((a, b) => a[1].localeCompare(b[1]))[0];
    recentSenders.delete(oldest[0]);
  }
}

export async function listRecent(): Promise<RecentSender[]> {
  if (env.redisPauseEnabled) {
    const redisRows = await withRedis("pause.list_recent", async (redis) => {
      const data = await redis.zrevrange(
        RECENT_SENDERS_KEY,
        0,
        MAX_RECENT - 1,
        "WITHSCORES",
      );
      const rows: RecentSender[] = [];
      for (let i = 0; i < data.length; i += 2) {
        const sender_id = data[i];
        const score = Number(data[i + 1]);
        if (!sender_id || !Number.isFinite(score)) continue;
        rows.push({
          sender_id,
          last_seen: new Date(score).toISOString(),
        });
      }
      return rows;
    });
    if (redisRows) return redisRows;
    recordCounter("pause.redis_fallback_total", 1, { operation: "listRecent" });
  }

  return Array.from(recentSenders.entries())
    .map(([sender_id, last_seen]) => ({ sender_id, last_seen }))
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}
