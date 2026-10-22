// Loaded into every test process and every CLI the tests start (`npm test` sets NODE_OPTIONS=--import this file): approval
// codes work at once, so a test can use the code a command just printed. test/hardening.test.js turns the wait back on
// (SATO_TEST_APPROVAL_WAIT=1) to test it.
import { approvalTiming } from "../src/approvals.js";

if (process.env.SATO_TEST_APPROVAL_WAIT !== "1") approvalTiming.minWaitMs = 0;
