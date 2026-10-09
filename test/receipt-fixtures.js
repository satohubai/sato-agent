// Offline fixtures for the build-receipt tests: a fake npm registry, a fake
// Solana JSON-RPC and (optionally) a fake Sato Hub MCP, all behind one `fetch`.
// Nothing here touches the network; a URL the world does not know throws.
//
// The schema account and the two "recorded" attestations are real bytes read
// from Solana devnet (test/fixtures/devnet-recorded.json). Everything else is
// encoded here, with the inverse of the reader's decoder.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { getAddressEncoder } from "@solana/kit";
import { DEPLOYMENTS, SAS_PROGRAM_ID, receiptAddress, receiptNonce } from "../src/receipts.js";

export const recorded = JSON.parse(readFileSync(new URL("./fixtures/devnet-recorded.json", import.meta.url), "utf8"));
export const golden = JSON.parse(readFileSync(new URL("./fixtures/sas-golden.json", import.meta.url), "utf8"));
export const RECORDED_JUP = { subject_id: "npm:@jup-ag/cli", version: "0.10.1", address: "YVPREi2EegmJDbNaxPvkSHTbdRHNWi6i7Lvn5PghSP2" };
export const RECORDED_DEX = { subject_id: "npm:dexpaprika-mcp", version: "2.5.1", address: "CBVTyRYhDkxd1wbbf1pxfZ65WxBpy58jKYzo7fS2pwZi" };

const sha = (alg, b) => createHash(alg).update(b).digest();
export const sha256Hex = (b) => sha("sha256", b).toString("hex");

// ── encoders (the inverse of src/receipts.js) ────────────────────────────────

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32(b.length), b]);
};
const addr = (a) => Buffer.from(getAddressEncoder().encode(a));

/** A receipt's data blob in the order of the recorded schema (digest is a VecU8, fund_action_count an i32). */
export function encodeData(f) {
  const count = Buffer.alloc(4);
  count.writeInt32LE(f.fund_action_count);
  return Buffer.concat([
    str(f.subject_kind ?? "package"),
    str(f.subject_id),
    str(f.version),
    u32(32), Buffer.from(f.digest, "hex"),
    str(f.key_access ?? "none_found"),
    str(f.key_egress ?? "not_observed"),
    count,
    str(f.method_version ?? "custody-2"),
    str(f.as_of ?? "2026-10-05"),
    str(f.reading_url ?? "https://satohub.ai/check/package/x"),
  ]);
}

/** A whole SAS attestation account, as the program stores it. */
export function encodeAttestation(o) {
  const dep = DEPLOYMENTS["mainnet-beta"];
  const data = encodeData(o);
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(BigInt(o.expiry ?? 0));
  return Buffer.concat([
    Buffer.from([2]),
    addr(o.nonce ?? receiptNonce(o.subject_id, o.version)),
    addr(o.credential ?? dep.credential),
    addr(o.schema ?? dep.schema),
    u32(data.length), data,
    addr(o.signer ?? dep.authority),
    expiry,
    addr(dep.authority), // token account: unused
  ]).toString("base64");
}

// ── tarballs ─────────────────────────────────────────────────────────────────

/** A real (tiny) .tgz: one file, package/package.json. */
export function makeTarball(name, version) {
  const body = Buffer.from(JSON.stringify({ name, version }));
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0" + "00", 257, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]));
}

// ── the world ────────────────────────────────────────────────────────────────

export const REGISTRY = "https://registry.npmjs.org/";
export const MCP_MOCK_URL = "http://sato-hub.mock/api/mcp";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/**
 * A world with these packages:
 *   mock-same@1.0.0       receipt on chain, digest = the tarball       -> same_build
 *   mock-diff@1.0.0       receipt on chain, digest = some other build  -> different_build
 *   mock-none@1.0.0       no receipt                                   -> no_reading
 *   @mock/scoped@2.0.0    receipt, fund_action_count stored as -1
 *   mock-latest           `latest` is 3.1.0, which has a receipt
 * Change world.rpc ("ok" | "http500" | "rpcerror"), world.accounts (address -> base64),
 * world.manifests, world.tarballs to build any other situation. world.calls logs every request.
 */
export async function makeWorld({ cluster = "mainnet-beta" } = {}) {
  const dep = DEPLOYMENTS[cluster];
  const world = { rpc: "ok", calls: [], accounts: {}, manifests: {}, tarballs: {}, mcp: true, cluster };
  world.accounts[dep.schema] = recorded.schema_b64;

  const pkg = (name, version, { receipt = true, digestOf = null, fund = 2, bytes = null } = {}) => {
    const tgz = bytes ?? makeTarball(name, version);
    const url = `${REGISTRY}${name}/-/${name.split("/").pop()}-${version}.tgz`;
    world.tarballs[url] = tgz;
    world.manifests[`${name}@${version}`] = {
      name,
      version,
      dist: { tarball: url, integrity: `sha512-${sha("sha512", tgz).toString("base64")}`, shasum: sha("sha1", tgz).toString("hex") },
    };
    world.pending ??= [];
    if (receipt) world.pending.push({ subject_id: `npm:${name}`, version, digest: digestOf ?? sha256Hex(tgz), fund_action_count: fund });
    return tgz;
  };
  pkg("mock-same", "1.0.0");
  pkg("mock-diff", "1.0.0", { digestOf: sha256Hex(Buffer.from("some other build")) });
  pkg("mock-none", "1.0.0", { receipt: false });
  pkg("@mock/scoped", "2.0.0", { fund: -1 });
  pkg("mock-latest", "3.1.0");
  world.manifests["mock-latest@latest"] = world.manifests["mock-latest@3.1.0"];
  world.manifests["mock-latest@next"] = world.manifests["mock-latest@3.1.0"];

  for (const p of world.pending) world.accounts[await receiptAddress(p.subject_id, p.version, dep)] = encodeAttestation(p);
  delete world.pending;
  world.pkg = pkg;
  world.addReceipt = async (p) => void (world.accounts[await receiptAddress(p.subject_id, p.version, dep)] = encodeAttestation(p));

  world.fetch = async (url, init = {}) => {
    url = String(url);
    world.calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.startsWith(REGISTRY)) {
      if (world.tarballs[url]) {
        const body = world.tarballs[url];
        return new Response(body, { status: 200, headers: { "content-length": String(world.contentLength ?? body.length) } });
      }
      const [, rest] = url.split(REGISTRY);
      const i = rest.lastIndexOf("/");
      const name = decodeURIComponent(rest.slice(0, i));
      const m = world.manifests[`${name}@${decodeURIComponent(rest.slice(i + 1))}`];
      return m ? json(m) : json({ error: "not found" }, 404);
    }
    if (/^https:\/\/api\.(mainnet-beta|devnet)\.solana\.com\/?$/.test(url) || url.startsWith("https://rpc.mock")) {
      if (world.rpc === "http500") return new Response("upstream down", { status: 500 });
      const req = JSON.parse(init.body);
      if (world.rpc === "rpcerror") return json({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "Node is behind by 1234 slots" } });
      if (req.method !== "getMultipleAccounts") throw new Error(`a read-only method was expected, got ${req.method}`);
      const [addrs] = req.params;
      return json({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          context: { slot: 1 },
          value: addrs.map((a) => {
            const b64 = world.accounts[a];
            return b64 ? { data: [b64, "base64"], owner: world.owners?.[a] ?? SAS_PROGRAM_ID, lamports: 1, executable: false } : null;
          }),
        },
      });
    }
    if (url === MCP_MOCK_URL && world.mcp) {
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "MOCK SATO CHECK TEXT" }], structuredContent: { mock: true } } })}\n`,
        { status: 200 },
      );
    }
    throw new Error(`test world: unexpected request to ${url}`);
  };
  return world;
}
