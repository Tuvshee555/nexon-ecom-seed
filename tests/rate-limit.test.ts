import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadRateLimitModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const redisStateModule = await import("../src/lib/redisState");
  redisStateModule.resetRedisStateForTests();
  const rateLimitModule = await import("../src/lib/rateLimit");
  rateLimitModule.resetRateLimitForTests();
  return { envModule, rateLimitModule, redisStateModule };
}

test("rate limiter blocks after configured limit", async () => {
  applyTestEnv();
  const { rateLimitModule } = await loadRateLimitModule();
  const key = "demo:test-client";
  const first = rateLimitModule.rateLimit(key, 2, 60_000);
  const second = rateLimitModule.rateLimit(key, 2, 60_000);
  const third = rateLimitModule.rateLimit(key, 2, 60_000);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
});

test("getClientKey falls back safely and validates proxy headers", async () => {
  applyTestEnv({ TRUST_PROXY_HEADERS: "true" });
  const { rateLimitModule } = await loadRateLimitModule();

  const fallbackRemote = rateLimitModule.getClientKey({
    headers: { "x-forwarded-for": "not-an-ip" },
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  });
  assert.equal(fallbackRemote, "127.0.0.1");

  const chainResult = rateLimitModule.getClientKey({
    headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9, garbage" },
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  });
  assert.equal(chainResult, "203.0.113.9");
});

test("rate limiter prunes high-cardinality bucket growth", async () => {
  applyTestEnv({ RATE_LIMIT_MAX_BUCKETS: "20000", RATE_LIMIT_SWEEP_INTERVAL: "1" });
  const { envModule, rateLimitModule } = await loadRateLimitModule();
  const maxBuckets = envModule.getEnv().rateLimitMaxBuckets;

  for (let i = 0; i < maxBuckets + 200; i += 1) {
    rateLimitModule.rateLimit(`spam:${i}`, 1, 120_000);
  }

  const diag = rateLimitModule.getRateLimitDiagnostics();
  assert.ok(
    diag.bucketCount <= maxBuckets,
    `bucket count ${diag.bucketCount} exceeded max ${maxBuckets}`,
  );
});

test("rateLimitAsync falls back safely when redis is enabled but unavailable", async () => {
  applyTestEnv({
    REDIS_STATE_ENABLED: "true",
    REDIS_RATE_LIMIT_ENABLED: "true",
    REDIS_URL: "redis://127.0.0.1:6399",
    REDIS_CONNECT_TIMEOUT_MS: "100",
    REDIS_COMMAND_TIMEOUT_MS: "100",
  });

  const { rateLimitModule } = await loadRateLimitModule();
  const first = await rateLimitModule.rateLimitAsync("demo:redis-fallback", 1, 60_000);
  const second = await rateLimitModule.rateLimitAsync("demo:redis-fallback", 1, 60_000);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
});
