import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Every request this package makes names itself. It runs on other people's
// machines, so it never claims to be Sato Hub's own tooling.
export const USER_AGENT = `sato-agent/${VERSION}`;
