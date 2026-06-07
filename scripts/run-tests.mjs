import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      const absolutePath = join(currentDir, entry);
      const stats = statSync(absolutePath);

      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (entry.endsWith(".test.ts")) {
        files.push(relative(process.cwd(), absolutePath));
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

const testFiles = collectTestFiles(join(process.cwd(), "tests"));

if (testFiles.length === 0) {
  console.error("No test files were found under tests/.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
