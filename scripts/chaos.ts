import { setTimeout as sleep } from "node:timers/promises";

function ensureEnv() {
  process.env.GEMINI_API_KEY ||= "chaos-gemini-key";
  process.env.VERIFY_TOKEN ||= "chaos-verify-token";
  process.env.TOKEN_PAGE ||= "chaos-page-token";
  process.env.FACEBOOK_PAGE_ID ||= "1234567890";
  process.env.META_APP_SECRET ||= "chaos-meta-secret";
  process.env.ADMIN_SECRET ||= "chaos-admin-secret";
  process.env.TRUST_PROXY_HEADERS ||= "true";
  process.env.ALLOW_ADMIN_SECRET_QUERY ||= "false";
  process.env.REDIS_STATE_ENABLED ||= "false";
  process.env.REDIS_RATE_LIMIT_ENABLED ||= "false";
  process.env.REDIS_REPLAY_ENABLED ||= "false";
  process.env.REDIS_CONVERSATION_ENABLED ||= "false";
  process.env.REDIS_PAUSE_ENABLED ||= "false";
}

async function run() {
  ensureEnv();

  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const env = envModule.getEnv();

  const rateLimitModule = await import("../src/lib/rateLimit");
  rateLimitModule.resetRateLimitForTests();

  const webhookModule = await import("../src/pages/api/webhook");
  webhookModule.resetWebhookStateForTests();

  const resilienceModule = await import("../src/lib/resilience");
  resilienceModule.resetResilienceStateForTests();
  const redisStateModule = await import("../src/lib/redisState");
  redisStateModule.resetRedisStateForTests();

  // Scenario 1: high-cardinality rate-limit abuse burst.
  const startRateBurst = Date.now();
  const burstCount = env.rateLimitMaxBuckets + 1000;
  for (let i = 0; i < burstCount; i += 1) {
    rateLimitModule.rateLimit(`chaos:${i}`, 1, 60_000);
  }
  const rateBurstDurationMs = Date.now() - startRateBurst;
  const rateDiag = rateLimitModule.getRateLimitDiagnostics();

  // Scenario 2: replay flood.
  const replayKey = webhookModule.buildEventKey("facebook", "sender-chaos", {
    message: { mid: "m-chaos-1", text: "hello" },
  });
  let replayAccepted = 0;
  let replayRejected = 0;
  for (let i = 0; i < 10_000; i += 1) {
    if (webhookModule.markEventProcessed(replayKey)) replayAccepted += 1;
    else replayRejected += 1;
  }

  // Scenario 3: upstream instability with retries (2 failures then success).
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      await sleep(50);
      return new Response("timeout candidate", { status: 503 });
    }
    if (attempts === 2) {
      return new Response("temporary failure", { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  let retryResult: { success: boolean; attempts: number; error?: string } = {
    success: false,
    attempts: 0,
  };
  try {
    const response = await resilienceModule.fetchWithRetry(
      "https://example.com/chaos",
      { method: "GET" },
      {
        upstream: "chaos.upstream",
        timeoutMs: 500,
        maxRetries: 3,
        retryBaseDelayMs: 10,
      },
    );
    retryResult = {
      success: response.response.ok,
      attempts: response.attempts,
    };
  } catch (error) {
    retryResult = {
      success: false,
      attempts,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }

  const webhookDiag = webhookModule.getWebhookRuntimeDiagnostics();

  // Scenario 4: Redis-enabled mode with unavailable Redis should degrade to local limiter.
  process.env.REDIS_STATE_ENABLED = "true";
  process.env.REDIS_RATE_LIMIT_ENABLED = "true";
  process.env.REDIS_URL = "redis://127.0.0.1:6399";
  process.env.REDIS_CONNECT_TIMEOUT_MS = "100";
  process.env.REDIS_COMMAND_TIMEOUT_MS = "100";

  envModule.resetEnvCacheForTests();
  redisStateModule.resetRedisStateForTests();
  const rateLimitRedisFallbackModule = await import("../src/lib/rateLimit");
  rateLimitRedisFallbackModule.resetRateLimitForTests();

  const redisFallbackFirst = await rateLimitRedisFallbackModule.rateLimitAsync(
    "chaos:redis-fallback",
    1,
    30_000,
  );
  const redisFallbackSecond = await rateLimitRedisFallbackModule.rateLimitAsync(
    "chaos:redis-fallback",
    1,
    30_000,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    scenarios: {
      highCardinalityRateLimit: {
        attemptedKeys: burstCount,
        durationMs: rateBurstDurationMs,
        resultingBuckets: rateDiag.bucketCount,
        maxBuckets: rateDiag.maxBuckets,
        bounded: rateDiag.bucketCount <= rateDiag.maxBuckets,
      },
      replayFlood: {
        attempts: 10_000,
        accepted: replayAccepted,
        rejected: replayRejected,
      },
      upstreamInstability: retryResult,
      redisUnavailableFallback: {
        firstAllowed: redisFallbackFirst.allowed,
        secondAllowed: redisFallbackSecond.allowed,
      },
      webhookState: webhookDiag,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(
    JSON.stringify({
      event: "chaos.failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
