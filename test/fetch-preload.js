// Preloaded (node --import) into a spawned CLI so a test can run the real
// `sato-agent check` end to end with no network: every fetch is answered by the
// offline world in receipt-fixtures.js, and any other URL throws.

import { makeWorld } from "./receipt-fixtures.js";

const world = await makeWorld({ cluster: process.env.SATO_TEST_CLUSTER || "mainnet-beta" });
if (process.env.SATO_TEST_RPC === "down") world.rpc = "http500";
globalThis.fetch = world.fetch;
