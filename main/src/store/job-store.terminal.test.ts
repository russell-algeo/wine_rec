import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";

// Optional Python test-only runtime, never a live Redis connection. Install the
// pinned packages listed in scripts/test-redis-terminal.py or point this variable
// at an isolated --target installation. The author validation ran every Lua case.
const env = { ...process.env, PYTHONPATH: [process.env.WINE_REC_FAKEREDIS_PATH, process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
const available = spawnSync("python3", ["-c", "import fakeredis, lupa"], { env }).status === 0;
describe("actual terminal Redis Lua transitions (offline)", () => {
  it.skipIf(!available)("keeps terminal state monotonic across 19 race/control cases", () => {
    const result = spawnSync("python3", [fileURLToPath(new URL("../../scripts/test-redis-terminal.py", import.meta.url))], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).passed).toBe(19);
  });
});
