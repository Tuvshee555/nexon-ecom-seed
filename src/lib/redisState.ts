import Redis from "ioredis";
import { getEnv } from "./env";
import {
  logInfo,
  logStartupDiagnostics,
  logWarn,
  recordCounter,
  setGauge,
} from "./observability";

const env = getEnv();
const REDIS_FAILURE_LOG_INTERVAL_MS = 30_000;

type RedisHealth = {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
};

let redisClient: Redis | null = null;
let connectPromise: Promise<Redis | null> | null = null;
let redisConnected = false;
let consecutiveFailures = 0;
let lastFailureLogAt = 0;
let lastErrorMessage: string | null = null;
let lastErrorAt: number | null = null;
let nextConnectAttemptAt = 0;

function redisEnabled() {
  return (
    env.redisStateEnabled &&
    Boolean(
      env.redisRateLimitEnabled ||
        env.redisReplayEnabled ||
        env.redisConversationEnabled ||
        env.redisPauseEnabled,
    )
  );
}

function throttleFailureLog(event: string, fields: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastFailureLogAt < REDIS_FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLogAt = now;
  logWarn(event, fields);
}

function markFailure(error: unknown, operation: string) {
  consecutiveFailures += 1;
  const message = error instanceof Error ? error.message : String(error);
  lastErrorMessage = message;
  lastErrorAt = Date.now();
  nextConnectAttemptAt =
    Date.now() + Math.min(10_000, Math.max(250, consecutiveFailures * 250));
  redisConnected = false;
  setGauge("redis.connected", 0);
  recordCounter("redis.operation_failed_total", 1, { operation });
  throttleFailureLog("redis.operation_failed", {
    operation,
    error: message,
    consecutiveFailures,
  });
}

function markSuccess(operation: string) {
  if (consecutiveFailures > 0) {
    logInfo("redis.operation_recovered", {
      operation,
      previousFailures: consecutiveFailures,
    });
  }
  consecutiveFailures = 0;
  nextConnectAttemptAt = 0;
  setGauge("redis.connected", 1);
}

function ensureRedisClient(): Redis | null {
  if (!redisEnabled() || !env.redisUrl) return null;
  if (redisClient) return redisClient;

  redisClient = new Redis(env.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: env.redisConnectTimeoutMs,
    commandTimeout: env.redisCommandTimeoutMs,
    keyPrefix: `${env.redisKeyPrefix}:`,
    retryStrategy: (times) => Math.min(times * 250, 4000),
  });

  redisClient.on("ready", () => {
    redisConnected = true;
    consecutiveFailures = 0;
    lastErrorMessage = null;
    lastErrorAt = null;
    setGauge("redis.connected", 1);
    logInfo("redis.ready", { status: redisClient?.status || "unknown" });
  });

  redisClient.on("error", (error) => {
    markFailure(error, "redis.event.error");
  });

  redisClient.on("close", () => {
    redisConnected = false;
    setGauge("redis.connected", 0);
  });

  redisClient.on("end", () => {
    redisConnected = false;
    setGauge("redis.connected", 0);
  });

  logStartupDiagnostics("redis", {
    enabled: redisEnabled(),
    configured: Boolean(env.redisUrl),
    keyPrefix: env.redisKeyPrefix,
    connectTimeoutMs: env.redisConnectTimeoutMs,
    commandTimeoutMs: env.redisCommandTimeoutMs,
  });

  return redisClient;
}

async function connectRedis(): Promise<Redis | null> {
  const client = ensureRedisClient();
  if (!client) return null;

  if (Date.now() < nextConnectAttemptAt) {
    return null;
  }

  if (client.status === "ready") {
    redisConnected = true;
    return client;
  }

  if (!connectPromise) {
    connectPromise = client
      .connect()
      .then(() => {
        redisConnected = true;
        setGauge("redis.connected", 1);
        return client;
      })
      .catch((error) => {
        markFailure(error, "redis.connect");
        return null;
      })
      .finally(() => {
        connectPromise = null;
      });
  }
  return connectPromise;
}

export async function withRedis<T>(
  operation: string,
  task: (client: Redis) => Promise<T>,
): Promise<T | null> {
  if (!redisEnabled()) return null;
  const client = await connectRedis();
  if (!client) {
    recordCounter("redis.unavailable_total", 1, { operation, reason: "connect" });
    return null;
  }

  try {
    const result = await task(client);
    markSuccess(operation);
    recordCounter("redis.operation_success_total", 1, { operation });
    return result;
  } catch (error) {
    markFailure(error, operation);
    return null;
  }
}

export function getRedisHealth(): RedisHealth {
  return {
    enabled: redisEnabled(),
    configured: Boolean(env.redisUrl),
    connected: redisConnected,
    status: redisClient?.status || "not_initialized",
    consecutiveFailures,
    lastError: lastErrorMessage,
    lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
  };
}

export function resetRedisStateForTests() {
  if (redisClient) {
    redisClient.disconnect(false);
  }
  redisClient = null;
  connectPromise = null;
  redisConnected = false;
  consecutiveFailures = 0;
  lastFailureLogAt = 0;
  lastErrorMessage = null;
  lastErrorAt = null;
  nextConnectAttemptAt = 0;
}
