import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadWebhookModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const webhookModule = await import("../src/pages/api/webhook");
  webhookModule.resetWebhookStateForTests();
  return webhookModule;
}

test("webhook dedupe marks replayed events as duplicates", async () => {
  applyTestEnv();
  const webhookModule = await loadWebhookModule();
  const key = webhookModule.buildEventKey("facebook", "sender-1", {
    message: { mid: "m-1", text: "hello" },
  });

  assert.equal(webhookModule.markEventProcessed(key), true);
  assert.equal(webhookModule.markEventProcessed(key), false);
});

test("webhook recent text dedupe normalizes repeated texts", async () => {
  applyTestEnv();
  const webhookModule = await loadWebhookModule();

  assert.equal(
    webhookModule.markRecentIncomingText("facebook", "sender-2", "Hello   World"),
    true,
  );
  assert.equal(
    webhookModule.markRecentIncomingText("facebook", "sender-2", "hello world"),
    false,
  );
});

test("webhook runtime diagnostics exposes bounded state counters", async () => {
  applyTestEnv();
  const webhookModule = await loadWebhookModule();
  const diag = webhookModule.getWebhookRuntimeDiagnostics();

  assert.equal(diag.activeConversations, 0);
  assert.equal(diag.pendingConversations, 0);
  assert.ok(diag.maxPendingConversations >= 100);
});
