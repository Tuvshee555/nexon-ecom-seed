import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadGeminiModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const resilienceModule = await import("../src/lib/resilience");
  resilienceModule.resetResilienceStateForTests();
  const geminiModule = await import("../src/lib/gemini");
  return { geminiModule, resilienceModule };
}

test("askGemini retries transient upstream failures and succeeds", async () => {
  applyTestEnv({
    GEMINI_MAX_RETRIES: "2",
    GEMINI_RETRY_BASE_DELAY_MS: "50",
    GEMINI_TIMEOUT_MS: "2000",
  });

  const { geminiModule } = await loadGeminiModule();
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 2) {
      return new Response("temporary error", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "Сайн байна уу" }] } },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 5,
          totalTokenCount: 17,
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await geminiModule.askGemini("hello", {
      source: "test.gemini",
    });
    assert.equal(result.text.includes("Сайн байна"), true);
    assert.equal(result.usage.total_tokens, 17);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("askGemini fails fast on timeout when retries are disabled", async () => {
  applyTestEnv({
    GEMINI_MAX_RETRIES: "0",
    GEMINI_TIMEOUT_MS: "25",
  });

  const { geminiModule } = await loadGeminiModule();
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
      () => geminiModule.askGemini("hello timeout", { source: "test.gemini" }),
      /timed out|gemini|timeout/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
