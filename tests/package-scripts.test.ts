import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production builds run readiness preflight before Next build", async () => {
  const raw = await readFile("package.json", "utf8");
  const pkg = JSON.parse(raw) as {
    scripts?: Record<string, string>;
  };

  assert.match(pkg.scripts?.prebuild || "", /scripts\/preflight\.ts/);
  assert.equal(pkg.scripts?.build, "next build");
});
