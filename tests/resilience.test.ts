import assert from "node:assert/strict";
import test from "node:test";
import {
  CircuitOpenError,
  executeWithCircuitBreaker,
  fetchWithRetry,
  resetResilienceStateForTests,
  TimeoutError,
  UpstreamHttpError,
} from "../src/lib/resilience";

test("fetchWithRetry retries retryable statuses and eventually succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response("upstream busy", { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchWithRetry(
      "https://example.com/retry",
      { method: "GET" },
      {
        upstream: "test.retry",
        timeoutMs: 1000,
        maxRetries: 3,
        retryBaseDelayMs: 1,
      },
    );
    assert.equal(result.response.status, 200);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry classifies timeout failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
    if (init?.signal) {
      init.signal.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    }
  })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        fetchWithRetry(
          "https://example.com/timeout",
          { method: "GET" },
          {
            upstream: "test.timeout",
            timeoutMs: 25,
            maxRetries: 0,
            retryBaseDelayMs: 1,
          },
        ),
      TimeoutError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executeWithCircuitBreaker opens circuit after repeated failures", async () => {
  resetResilienceStateForTests();

  const failingTask = async () => {
    throw new UpstreamHttpError("test.circuit", 503, "boom");
  };

  await assert.rejects(
    () =>
      executeWithCircuitBreaker(
        {
          upstream: "test.circuit",
          failureThreshold: 2,
          cooldownMs: 1_000,
        },
        failingTask,
      ),
    UpstreamHttpError,
  );

  await assert.rejects(
    () =>
      executeWithCircuitBreaker(
        {
          upstream: "test.circuit",
          failureThreshold: 2,
          cooldownMs: 1_000,
        },
        failingTask,
      ),
    UpstreamHttpError,
  );

  await assert.rejects(
    () =>
      executeWithCircuitBreaker(
        {
          upstream: "test.circuit",
          failureThreshold: 2,
          cooldownMs: 1_000,
        },
        async () => "should_not_run",
      ),
    CircuitOpenError,
  );
});
