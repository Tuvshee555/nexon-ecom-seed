import net from "net";
import { getEnv } from "./env";
import { recordCounter, setGauge } from "./observability";
import { withRedis } from "./redisState";

type Bucket = { hits: number; reset: number; lastSeen: number };
type LimitResult = { allowed: boolean; remaining: number; reset: number };

const env = getEnv();
const buckets = new Map<string, Bucket>();
let callsSinceSweep = 0;
const REDIS_RATE_LIMIT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

local current = redis.call("INCR", key)
if current == 1 then
  redis.call("PEXPIRE", key, window_ms)
end

local ttl = redis.call("PTTL", key)
if ttl < 0 then
  redis.call("PEXPIRE", key, window_ms)
  ttl = window_ms
end

local remaining = limit - current
if remaining < 0 then
  remaining = 0
end

local allowed = 0
if current <= limit then
  allowed = 1
end

local reset = now_ms + ttl
return { allowed, remaining, reset }
`;

function pruneBuckets(now: number, force: boolean) {
  callsSinceSweep += 1;
  if (!force && callsSinceSweep < env.rateLimitSweepInterval) return;
  callsSinceSweep = 0;

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.reset <= now) {
      buckets.delete(key);
    }
  }

  const overflow = buckets.size - env.rateLimitMaxBuckets;
  if (overflow <= 0) return;

  // Overflow mode only; keep the oldest buckets to cap memory usage.
  const eviction = Array.from(buckets.entries())
    .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    .slice(0, overflow);

  for (const [key] of eviction) {
    buckets.delete(key);
  }
  recordCounter("rate_limit.evictions_total", eviction.length, {
    reason: "overflow",
  });
}

function keyScope(key: string) {
  const pieces = key.split(":");
  return pieces.slice(0, Math.min(2, pieces.length)).join(":") || "unknown";
}

export function rateLimit(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  pruneBuckets(now, false);
  const scope = keyScope(key);
  recordCounter("rate_limit.checks_total", 1, { scope });

  const bucket = buckets.get(key);

  if (!bucket || bucket.reset <= now) {
    const reset = now + windowMs;
    buckets.set(key, { hits: 1, reset, lastSeen: now });
    if (buckets.size > env.rateLimitMaxBuckets) pruneBuckets(now, true);
    setGauge("rate_limit.bucket_count", buckets.size, {});
    recordCounter("rate_limit.allowed_total", 1, { scope });
    return { allowed: true, remaining: limit - 1, reset };
  }

  if (bucket.hits >= limit) {
    bucket.lastSeen = now;
    recordCounter("rate_limit.blocked_total", 1, { scope });
    return { allowed: false, remaining: 0, reset: bucket.reset };
  }

  bucket.hits += 1;
  bucket.lastSeen = now;
  setGauge("rate_limit.bucket_count", buckets.size, {});
  recordCounter("rate_limit.allowed_total", 1, { scope });
  return {
    allowed: true,
    remaining: limit - bucket.hits,
    reset: bucket.reset,
  };
}

export async function rateLimitAsync(
  key: string,
  limit: number,
  windowMs: number,
): Promise<LimitResult> {
  if (!env.redisRateLimitEnabled) {
    return rateLimit(key, limit, windowMs);
  }

  const scope = keyScope(key);
  recordCounter("rate_limit.checks_total", 1, { scope, backend: "redis" });

  const redisResult = await withRedis("rate_limit.check", async (redis) => {
    const output = (await redis.eval(
      REDIS_RATE_LIMIT_LUA,
      1,
      `rate_limit:${key}`,
      String(limit),
      String(windowMs),
      String(Date.now()),
    )) as unknown[];

    const [allowedRaw, remainingRaw, resetRaw] = output;
    return {
      allowed: Number(allowedRaw) === 1,
      remaining: Math.max(0, Number(remainingRaw)),
      reset: Number(resetRaw),
    } as LimitResult;
  });

  if (!redisResult) {
    recordCounter("rate_limit.redis_fallback_total", 1, { scope });
    return rateLimit(key, limit, windowMs);
  }

  recordCounter(
    redisResult.allowed ? "rate_limit.allowed_total" : "rate_limit.blocked_total",
    1,
    { scope, backend: "redis" },
  );
  return redisResult;
}

type ClientLike = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
};

function pickHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(",");
  }
  return value?.trim() ?? "";
}

function normalizeIp(candidate: string): string {
  if (!candidate) return "";
  const trimmed = candidate.trim();
  const bracketedIpv6 = trimmed.match(/^\[([a-fA-F0-9:]+)\](?::\d+)?$/);
  if (bracketedIpv6?.[1] && net.isIP(bracketedIpv6[1])) return bracketedIpv6[1];

  const withOptionalPort = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  if (withOptionalPort?.[1] && net.isIP(withOptionalPort[1])) return withOptionalPort[1];

  const ipv4Mapped = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  if (net.isIP(ipv4Mapped)) return ipv4Mapped;
  return "";
}

function extractForwardedIp(headerValue: string): string {
  if (!headerValue) return "";
  const chain = headerValue
    .split(",")
    .map((part) => normalizeIp(part))
    .filter(Boolean);
  if (!chain.length) return "";

  // Conservative choice: closest hop to the app is harder to spoof than left-most values.
  return chain[chain.length - 1] || "";
}

export function getClientKey(req: ClientLike) {
  const trustProxyHeaders = env.trustProxyHeaders;

  if (trustProxyHeaders) {
    const vercelForwarded = pickHeaderValue(req.headers?.["x-vercel-forwarded-for"]);
    const forwarded = pickHeaderValue(req.headers?.["x-forwarded-for"]);
    const realIpHeader = pickHeaderValue(req.headers?.["x-real-ip"]);

    const vercelIp = extractForwardedIp(vercelForwarded);
    if (vercelIp) return vercelIp;

    const forwardedIp = extractForwardedIp(forwarded);
    if (forwardedIp) return forwardedIp;

    const realIp = normalizeIp(realIpHeader);
    if (realIp) return realIp;
  }

  const remote = normalizeIp(req.socket?.remoteAddress || "");
  if (remote) return remote;
  return "unknown";
}

export function buildShardedRateLimitKey(
  prefix: string,
  partitionSource: string,
  shardCount = 16,
): string {
  const safeShardCount = Math.max(1, Math.floor(shardCount));
  let hash = 0;
  for (let i = 0; i < partitionSource.length; i += 1) {
    hash = (hash * 31 + partitionSource.charCodeAt(i)) >>> 0;
  }
  const shard = hash % safeShardCount;
  return `${prefix}:shard:${shard}`;
}

export function getRateLimitDiagnostics() {
  return {
    bucketCount: buckets.size,
    callsSinceSweep,
    maxBuckets: env.rateLimitMaxBuckets,
    redisRateLimitEnabled: env.redisRateLimitEnabled,
  };
}

export function resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}
