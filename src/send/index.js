// `send` of any asset in the wallet, on any chain: the native coin, a stablecoin, the wrapped native, or any token by its address or mint.
// The chain halves are ./evm.js and ./solana.js; this file picks one, and re-exports the parts the CLI shows and binds.

import { isEvm } from "../chains.js";
import { executeEvmSend, planEvmSend } from "./evm.js";
import { executeSolanaSend, planSolanaSend } from "./solana.js";

export { approvalBound, isAll, ledgerSpend, verifyBound, sendFields, sendIntent, sendLines, NO_FEE_LINE, UNPRICED_LINE } from "./common.js";

/** Work out and prove one send (reads the chain; signs and sends nothing). */
export const planSend = (req, deps = {}) => (isEvm(req.chain) ? planEvmSend(req, deps) : planSolanaSend(req, deps));

/** Reserve, sign, record, broadcast and wait for a planned send. */
export const executeSend = (plan, deps = {}) => (isEvm(plan.chain) ? executeEvmSend(plan, deps) : executeSolanaSend(plan, deps));
