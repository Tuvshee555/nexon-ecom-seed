import {
  classifyError,
  logError,
  logInfo,
  recordCounter,
  recordHistogram,
} from "./observability";

const DEFAULT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type CircuitState = {
  consecutiveFailures: number;
  openUntilMs: number;
};

export class UpstreamHttpError extends Error {
  status: number;

  upstream: string;

  bodySnippet: string;

  constructor(upstream: string, status: number, bodySnippet: string) {
    super(`Upstream ${upstream} returned ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.upstream = upstream;
    this.bodySnippet = bodySnippet;
  }
}

export class TimeoutError extends Error {
  timeoutMs: number;

  upstream: string;

  constructor(upstream: string, timeoutMs: number) {
    super(`Upstream ${upstream} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    this.upstream = upstream;
    (this as unknown as { code: string }).code = "ETIMEDOUT";
  }
}

export class CircuitOpenError extends Error {
  upstream: string;

  retryAfterMs: number;

  constructor(upstream: string, retryAfterMs: number) {
    super(`Circuit for ${upstream} is open`);
    this.name = "CircuitOpenError";
    this.upstream = upstream;
    this.retryAfterMs = retryAfterMs;
    (this as unknown as { code: string }).code = "CIRCUIT_OPEN";
  }
}

export type RetryOptions = {
  upstream: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryableStatusCodes?: number[];
  requestId?: string;
  correlationId?: string;
  metricPrefix?: string;
};

export type CircuitOptions = {
  upstream: string;
  failureThreshold: number;
  cooldownMs: number;
  requestId?: string;
  correlationId?: string;
};

const circuitStates = new Map<string, CircuitState>();

function truncateBody(raw: string, maxLen = 500) {
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}...[truncated]`;
}

function isRetryableStatus(status: number, custom?: number[]) {
  if (custom && custom.length > 0) return custom.includes(status);
  return DEFAULT_RETRYABLE_STATUS.has(status);
}

function isRetryableError(error: unknown) {
  const info = classifyError(error);
  return info.retryable;
}

function delayMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function withJitter(baseMs: number) {
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseMs * 0.2)));
  return baseMs + jitter;
}

function sleepForAttempt(baseDelayMs: number, attemptIndex: number) {
  const exponential = baseDelayMs * 2 ** Math.max(0, attemptIndex - 1);
  const bounded = Math.min(exponential, 10_000);
  return delayMs(withJitter(bounded));
}

function beginTimer(timeoutMs: number, controller: AbortController, upstream: string) {
  return setTimeout(() => {
    controller.abort(new TimeoutError(upstream, timeoutMs));
  }, timeoutMs);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions,
) {
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, options.maxRetries + 1);
  const metricPrefix = options.metricPrefix || "upstream";

  let attempt = 0;
  let lastError: unknown = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeoutHandle = beginTimer(options.timeoutMs, controller, options.upstream);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - attemptStartedAt;
      recordHistogram(`${metricPrefix}.latency_ms`, durationMs, {
        upstream: options.upstream,
        status_code: response.status,
      });
      recordCounter(`${metricPrefix}.requests_total`, 1, {
        upstream: options.upstream,
        status_code: response.status,
      });

      if (response.ok) {
        if (attempt > 1) {
          recordCounter(`${metricPrefix}.retry_success_total`, 1, {
            upstream: options.upstream,
          });
        }
        return { response, attempts: attempt, durationMs: Date.now() - startedAt };
      }

      const body = await response.text().catch(() => "");
      const err = new UpstreamHttpError(options.upstream, response.status, truncateBody(body));
      lastError = err;
      const canRetry = attempt < maxAttempts && isRetryableStatus(response.status, options.retryableStatusCodes);
      recordCounter(`${metricPrefix}.errors_total`, 1, {
        upstream: options.upstream,
        category: classifyError(err).category,
        status_code: response.status,
      });
      if (!canRetry) throw err;

      recordCounter(`${metricPrefix}.retries_total`, 1, {
        upstream: options.upstream,
        reason: "status",
      });
      await sleepForAttempt(options.retryBaseDelayMs, attempt);
    } catch (error) {
      clearTimeout(timeoutHandle);
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetryableError(error);
      const classification = classifyError(error);
      recordCounter(`${metricPrefix}.errors_total`, 1, {
        upstream: options.upstream,
        category: classification.category,
      });
      if (!canRetry) {
        throw error;
      }
      recordCounter(`${metricPrefix}.retries_total`, 1, {
        upstream: options.upstream,
        reason: classification.category,
      });
      await sleepForAttempt(options.retryBaseDelayMs, attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown upstream retry failure");
}

export async function executeWithCircuitBreaker<T>(
  options: CircuitOptions,
  task: () => Promise<T>,
) {
  const now = Date.now();
  const state = circuitStates.get(options.upstream) || {
    consecutiveFailures: 0,
    openUntilMs: 0,
  };

  if (state.openUntilMs > now) {
    const retryAfterMs = state.openUntilMs - now;
    recordCounter("circuit.open_reject_total", 1, {
      upstream: options.upstream,
    });
    throw new CircuitOpenError(options.upstream, retryAfterMs);
  }

  try {
    const result = await task();
    if (state.consecutiveFailures > 0 || state.openUntilMs > 0) {
      logInfo("circuit.recovered", {
        upstream: options.upstream,
        previousFailures: state.consecutiveFailures,
      });
    }
    circuitStates.set(options.upstream, { consecutiveFailures: 0, openUntilMs: 0 });
    return result;
  } catch (error) {
    const failureState = circuitStates.get(options.upstream) || {
      consecutiveFailures: 0,
      openUntilMs: 0,
    };
    failureState.consecutiveFailures += 1;

    if (failureState.consecutiveFailures >= options.failureThreshold) {
      failureState.openUntilMs = Date.now() + options.cooldownMs;
      recordCounter("circuit.open_total", 1, {
        upstream: options.upstream,
      });
      logError("circuit.opened", {
        upstream: options.upstream,
        failures: failureState.consecutiveFailures,
        cooldownMs: options.cooldownMs,
        classification: classifyError(error),
      });
    }

    circuitStates.set(options.upstream, failureState);
    throw error;
  }
}

export function getCircuitState(upstream: string) {
  const state = circuitStates.get(upstream);
  if (!state) {
    return {
      consecutiveFailures: 0,
      openUntilMs: 0,
      isOpen: false,
    };
  }
  return {
    consecutiveFailures: state.consecutiveFailures,
    openUntilMs: state.openUntilMs,
    isOpen: state.openUntilMs > Date.now(),
  };
}

export function logRetryFailure(
  upstream: string,
  error: unknown,
  context?: Record<string, unknown>,
) {
  logError("upstream.request_failed", {
    upstream,
    classification: classifyError(error),
    ...(error instanceof Error
      ? { message: error.message, name: error.name }
      : { error: String(error) }),
    ...context,
  });
}

export function resetResilienceStateForTests() {
  circuitStates.clear();
}
