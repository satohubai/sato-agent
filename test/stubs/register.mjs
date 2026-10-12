// Test only: preloaded into a spawned CLI (node --import) so `swap` runs against a stub of src/swap/run.js. The CLI itself is the
// real bin/sato-agent.js; only the chain-facing swap module is replaced. See referral-names.test.js.
import { register } from "node:module";

register("./swap-run-hooks.mjs", import.meta.url);
