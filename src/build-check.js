// `sato-agent check`, receipts half: for each npm package an install command
// names, read its Sato Check build receipt from Solana and say whether the
// tarball npm serves for that version is the build the receipt describes.
//
// A receipt DESCRIBES; it never decides. Whatever the status, this never blocks
// anything and never grades a package. Reading the chain needs no key and makes
// no call to Sato Hub.

import { DEPLOYMENTS, SAS_PROGRAM_ID, jsonRpcOverFetch, matchBuild, normalizeCluster, readReceiptsFromChain, rpcUrlFor } from "./receipts.js";
import { digestFromManifest, fetchManifest, parseInstallCommand } from "./npm.js";
import { clean } from "./text.js";

export const HEADER = "Solana build receipt (dated Sato Check reading, written onchain; it describes, it does not decide)";

// Packages are compared with what registry.npmjs.org serves. A project or user
// .npmrc can send the real install somewhere else, which this does not read.
export const NPMRC_NOTE = "Compared with what registry.npmjs.org serves. A project or user .npmrc can redirect an install to another registry; this check does not read it.";

const STATUS_TEXT = {
  same_build: "same build as recorded",
  different_build: "different build",
  no_reading: "no reading for this build",
  receipt_expired: "a receipt existed for this build but it has expired",
  not_a_sato_receipt: "an account exists at the receipt address but it is not a Sato Hub receipt",
  chain_unreadable: "the chain could not be read (this is not the same as no reading)",
  build_unchecked: "this build could not be fetched to compare",
};

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const message = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Build the receipts report for an install command. Never throws for a package
 * that cannot be read: that package gets its own status and error. `cluster`
 * must already be valid (see normalizeCluster).
 *
 * Injectable for tests: fetch (registry), rpc (a JSON-RPC caller), now.
 */
export async function checkBuilds(command, { cluster = "mainnet-beta", fetch: fetchImpl = fetch, rpc = null, rpcUrl = null, now = Date.now } = {}) {
  const deployment = DEPLOYMENTS[cluster];
  if (!deployment) throw new Error(`unknown cluster "${cluster}"`);
  const url = rpcUrl ?? rpcUrlFor(cluster);
  const { packages, skipped } = parseInstallCommand(command);

  // 1. Which version is each package? An exact version is taken as given; no
  //    version (or a dist-tag) is resolved from the registry and said so.
  const manifests = await pool(packages, 4, async (p) => {
    try {
      const m = await fetchManifest(p.name, p.kind === "exact" ? p.requested : (p.requested ?? "latest"), { fetch: fetchImpl });
      return { manifest: m, error: null };
    } catch (e) {
      return { manifest: null, error: message(e) };
    }
  });

  const entries = packages.map((p, i) => {
    const { manifest, error } = manifests[i];
    const version = manifest?.version ?? (p.kind === "exact" ? p.requested : null);
    const resolvedFrom = p.kind === "exact" ? null : (p.requested ?? "latest");
    return {
      subject_id: p.subject_id,
      package: p.name,
      version,
      version_requested: p.requested,
      version_resolved_from_latest: resolvedFrom === "latest",
      version_resolved_from: resolvedFrom,
      status: null,
      installed_sha256: null,
      integrity_check: null,
      receipt: null,
      ...(error ? { error } : {}),
      _manifest: manifest,
    };
  });

  // 2. One chain read for every package whose version is known.
  const withVersion = entries.filter((e) => e.version);
  let chain = new Map();
  if (withVersion.length > 0) {
    const call = rpc ?? jsonRpcOverFetch(url, fetchImpl);
    chain = await readReceiptsFromChain(call, deployment, withVersion.map((e) => ({ subject_id: e.subject_id, version: e.version })), now);
  }

  // 3. A status for each; download the tarball only where there is a receipt to compare it to.
  for (const e of entries) {
    if (!e.version) {
      e.status = "build_unchecked";
      continue;
    }
    const r = chain.get(`${e.subject_id}@${e.version}`);
    if (r?.untrusted) {
      // Something is at the receipt address, but it failed a check: not a reading at all.
      e.status = "not_a_sato_receipt";
      e.error = r.error;
    } else if (!r || !r.ok) {
      e.status = "chain_unreadable";
      e.error = r?.error ?? "no answer from the chain";
    } else if (r.expired) {
      e.status = "receipt_expired";
      if (r.note) e.note = r.note;
    } else if (!r.receipt) {
      e.status = "no_reading";
    } else {
      e.receipt = r.receipt;
    }
  }
  const toCompare = entries.filter((e) => e.receipt);
  await pool(toCompare, 3, async (e) => {
    if (!e._manifest) {
      e.status = "build_unchecked";
      e.error = e.error ?? "the npm registry manifest could not be read";
      return;
    }
    try {
      const d = await digestFromManifest(e._manifest, { fetch: fetchImpl });
      e.installed_sha256 = d.sha256;
      e.integrity_check = d.integrity_check;
      e.status = matchBuild(e.receipt, d.sha256);
    } catch (err) {
      e.status = "build_unchecked";
      e.error = message(err);
    }
  });
  for (const e of entries) delete e._manifest;

  return {
    command,
    receipts: entries,
    skipped,
    deployment: { cluster, credential: deployment.credential, schema: deployment.schema, authority: deployment.authority, program: SAS_PROGRAM_ID },
    rpc_host: (() => {
      try {
        return new URL(url).host;
      } catch {
        return "the configured Solana RPC";
      }
    })(),
    registry_note: NPMRC_NOTE,
  };
}

// ── printing ─────────────────────────────────────────────────────────────────

// Text that came from the chain or the registry is shown as plain, short, single-line text (src/text.js).
export { clean };

const shownUrl = (u) => {
  try {
    return new URL(u).protocol === "https:" ? clean(u, 300) : "(not an https address; not shown)";
  } catch {
    return "(not a web address; not shown)";
  }
};

function entryText(e) {
  const lines = [];
  const how = e.version_resolved_from
    ? `  (no version given: resolved ${e.version_resolved_from === "latest" ? "latest" : `tag "${clean(e.version_resolved_from, 40)}"`} from the npm registry)`
    : "";
  lines.push(`${clean(e.subject_id, 120)}@${e.version ? clean(e.version, 60) : "(version unknown)"}${how}`);
  lines.push(`  ${STATUS_TEXT[e.status]}`);
  if (e.status === "same_build") {
    lines.push("  The tarball npm serves for this version has the sha256 Sato Check read. That says the bytes match; it says nothing more.");
  } else if (e.status === "different_build") {
    lines.push("  The tarball npm serves for this version has a different sha256 than the build Sato Check read, so the reading below is about another build.");
    lines.push(`  npm tarball sha256   ${e.installed_sha256}`);
    lines.push(`  recorded sha256      ${e.receipt.digest_hex}`);
  } else if (e.status === "no_reading") {
    lines.push("  No receipt exists on Solana for this exact version. That means no reading was written; it does not mean anything is wrong.");
  } else if (e.status === "receipt_expired") {
    lines.push(`  A receipt existed for this build but it has expired${e.note ? ` (${clean(e.note, 100)})` : ""}, so it is not shown as a current reading.`);
  }
  if (e.error) lines.push(`  ${e.status === "chain_unreadable" ? "error from the chain read" : "reason"}: ${clean(e.error, 300)}`);
  if (e.receipt) {
    const r = e.receipt;
    const pad = (k) => `  ${k}`.padEnd(22);
    lines.push(`${pad("key access")}${clean(r.key_access, 60)}`);
    lines.push(`${pad("key egress")}${clean(r.key_egress, 60)}`);
    lines.push(`${pad("fund actions found")}${r.fund_action_count === null ? "unknown" : r.fund_action_count}`);
    lines.push(`${pad("method")}${clean(r.method_version, 60)}`);
    lines.push(`${pad("reading as of")}${clean(r.as_of, 60)}`);
    lines.push(`${pad("full reading")}${shownUrl(r.reading_url)}`);
    lines.push(`${pad("attestation")}${r.attestation_address} (${r.cluster})`);
    lines.push(`${pad("explorer")}${r.explorer_url}`);
  }
  return lines.join("\n");
}

/** The receipts block for the terminal. Never contains a verdict. */
export function renderReceipts(report) {
  const out = [HEADER];
  if (report.receipts.length === 0) {
    out.push("No npm package found in this command, so no build receipt was looked up.");
  } else {
    out.push(`Read from Solana ${report.deployment.cluster} through ${clean(report.rpc_host, 100)}, with no key and no call to Sato Hub.`);
    out.push("");
    out.push(report.receipts.map(entryText).join("\n\n"));
    out.push("");
    out.push(NPMRC_NOTE);
  }
  for (const s of report.skipped) out.push(`Not looked up: ${clean(s.spec, 120)} (${s.reason}).`);
  return out.join("\n");
}
