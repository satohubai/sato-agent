// "If a check can't run" belongs to the check gate: turning the gate off clears it,
// and turning it back on asks again (live test, 2026-10-09: status kept showing it
// after the gate was off, and there was no way to clear it).

import assert from "node:assert/strict";
import test from "node:test";
import { freshHome } from "./helpers.js";

freshHome();
const { loadPolicy, setPolicy } = await import("../src/policy.js");

test("gate off clears the can't-run choice; gate back on needs it chosen again", () => {
  setPolicy({ chains: "base", perTx: "3", perDay: "25", checkGate: "no", onCheckUnavailable: "refuse" });
  assert.equal(loadPolicy().on_check_unavailable, "refuse");
  const off = setPolicy({ checkGate: "off" });
  assert.equal(loadPolicy().on_check_unavailable, null);
  assert.deepEqual(off.raises, ["check_gate loosened"], "only the gate change counts as a loosening");
  assert.throws(() => setPolicy({ checkGate: "caution" }), /--on-check-unavailable/);
  setPolicy({ checkGate: "caution", onCheckUnavailable: "allow" });
  assert.equal(loadPolicy().on_check_unavailable, "allow");
});
