// The kit is a CLI. Its modules are not an API: on 2026-10-19 a bot went around the kit and
// signed Jupiter swaps without Sato Hub's fee. The fee checks inside the swap modules are the
// guard (test/swap-solana.test.js); the exports map is the speed bump in front of them, so a
// script cannot `import "sato-agent/src/..."` and call the signing code with its own arguments.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package.json exports nothing but itself: the kit's modules are not importable by package name", () => {
  assert.deepEqual(pkg.exports, { "./package.json": "./package.json" });
  assert.equal(pkg.main, undefined, "a main entry would expose a module");
  assert.deepEqual(pkg.bin, { "sato-agent": "bin/sato-agent.js" }, "the CLI is the interface");
});
