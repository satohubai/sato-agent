// npm side of `sato-agent check`: pick the packages out of an install command
// (text only: nothing is ever executed), resolve a version, and hash the exact
// tarball the npm registry serves for it.

import { createHash } from "node:crypto";
import { USER_AGENT } from "./version.js";

export const REGISTRY = "https://registry.npmjs.org/";
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/** More packages than this in one command are listed as skipped, not downloaded. */
export const MAX_PACKAGES = 10;

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── reading an install command ───────────────────────────────────────────────

/** Split into words and operators (&& || ; |), honouring simple quotes. Nothing is expanded or run. */
function tokenize(command) {
  const tokens = [];
  let cur = "";
  let has = false;
  let quote = null;
  const push = () => {
    if (has) tokens.push({ t: cur });
    cur = "";
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c) && c !== "\n") {
      push();
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      push();
      if ((c === "|" || c === "&") && command[i + 1] === c) i++; // && and ||
      tokens.push({ op: true }); // each of these ends one command
    } else {
      cur += c;
      has = true;
    }
  }
  push();
  const out = [[]];
  for (const tok of tokens) {
    if (tok.op) out.push([]);
    else out[out.length - 1].push(tok.t);
  }
  return out.filter((s) => s.length > 0);
}

// Flags that take their value as the NEXT word, so it is not mistaken for a package.
const VALUE_FLAGS = new Set([
  "--registry", "--prefix", "--tag", "--cache", "--userconfig", "--loglevel", "--workspace", "-w",
  "--filter", "--dir", "-C", "--cwd", "--save-prefix", "--access", "--otp", "--scope", "--node-options",
  "--cwd", "--directory",
]);
const PKG_FLAGS = new Set(["-p", "--package"]);

// An install that names another registry (or another npm config file, which can
// name one) would fetch something other than what registry.npmjs.org serves, so
// comparing that tarball with a receipt would describe the wrong bytes. Those
// packages are skipped, not looked up. (A project or user .npmrc can redirect an
// install too; that is not visible in the command, and the output says so.)
export const OTHER_REGISTRY = "installs from another registry";
const REGISTRY_FLAG_RE = /^--(?:reg(?:i(?:s(?:t(?:r(?:y)?)?)?)?)?|userconfig|@[^\s=:]+:registry)(?:=|$)/;
const REGISTRY_ENV_RE = /^npm_config_(?:registry|userconfig|@[^\s=:]+:registry)=/i;
const redirectsRegistry = (w) => REGISTRY_FLAG_RE.test(w) || REGISTRY_ENV_RE.test(w);

const NAME_RE = /^(?:@[A-Za-z0-9~_-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~_-][A-Za-z0-9._~-]*$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TAG_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SHELL_SYNTAX_RE = /[$`(){}<>\\*?!]/;

/** `name`, `name@1.2.3`, `@scope/name`, `@scope/name@next` -> { name, spec } or { skip }. */
export function parsePackageSpec(raw) {
  if (SHELL_SYNTAX_RE.test(raw)) return { skip: { spec: raw, reason: "shell syntax, not interpreted" } };
  if (/^(?:\.{0,2}\/|~|file:|git[+:@]|github:|gitlab:|bitbucket:|https?:|npm:|workspace:|link:|portal:)/.test(raw) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(raw) && !raw.startsWith("@")) {
    return { skip: { spec: raw, reason: "not a registry package name (path, URL, git, alias or workspace)" } };
  }
  const at = raw.lastIndexOf("@");
  const name = at > 0 ? raw.slice(0, at) : raw;
  const spec = at > 0 ? raw.slice(at + 1) : "";
  if (name.length > 214 || !NAME_RE.test(name)) return { skip: { spec: raw, reason: "not a valid npm package name" } };
  if (spec === "" || spec === "latest") return { name, requested: null, kind: "latest" };
  if (EXACT_VERSION_RE.test(spec)) return { name, requested: spec, kind: "exact" };
  if (TAG_RE.test(spec)) return { name, requested: spec, kind: "tag" };
  return { skip: { spec: raw, reason: "a version range has no single build to compare; pin an exact version" } };
}

/**
 * The npm packages named by an install command. Strict and text-only:
 *   npm i|install|add, pnpm add|i|install, yarn add, bun add|install|a, and
 *   npx|pnpx|bunx|`pnpm dlx`|`yarn dlx`|`bun x` [-y] pkg[@version].
 * Flags are ignored. Returns { packages: [{ name, subject_id, requested, kind }],
 * skipped: [{ spec, reason }] }. A command that names no package (a pip install,
 * an MCP config, plain junk) returns empty lists; callers say so and carry on.
 */
export function parseInstallCommand(command) {
  const packages = [];
  const skipped = [];
  const seen = new Set();
  let exported = false; // an earlier `export NPM_CONFIG_REGISTRY=...` (or a bare assignment) applies to what follows
  const add = (raw, redirected) => {
    if (redirected) return void skipped.push({ spec: raw, reason: OTHER_REGISTRY });
    const p = parsePackageSpec(raw);
    if (p.skip) return void skipped.push(p.skip);
    const key = `${p.name}@${p.requested ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (packages.length >= MAX_PACKAGES) return void skipped.push({ spec: raw, reason: `over the ${MAX_PACKAGES} package limit for one check` });
    packages.push({ name: p.name, subject_id: `npm:${p.name}`, requested: p.requested, kind: p.kind });
  };

  for (const words of tokenize(String(command ?? ""))) {
    const redirected = exported || words.some(redirectsRegistry);
    const onlyAssignments = words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if ((["export", "set", "setenv"].includes(words[0]) || onlyAssignments) && words.some((w) => REGISTRY_ENV_RE.test(w))) exported = true;
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["sudo", "env", "command", "time"].includes(words[i]))) i++;
    const tool = words[i++];
    let mode = null; // "install" (list of packages) or "exec" (first non-flag word is the package)
    const next = words[i];
    if (tool === "npm") {
      if (["i", "in", "ins", "inst", "insta", "instal", "install", "add"].includes(next)) mode = "install";
      else if (next === "exec" || next === "x") mode = "exec";
    } else if (tool === "pnpm") {
      if (["add", "i", "install"].includes(next)) mode = "install";
      else if (next === "dlx") mode = "exec";
    } else if (tool === "yarn") {
      if (next === "add") mode = "install";
      else if (next === "dlx") mode = "exec";
    } else if (tool === "bun") {
      if (["add", "a", "install", "i"].includes(next)) mode = "install";
      else if (next === "x") mode = "exec";
    } else if (["npx", "pnpx", "bunx"].includes(tool)) {
      mode = "exec";
      i--; // no subcommand word to skip
    }
    if (!mode) continue;
    i++; // past the subcommand
    const pkgFlagValues = [];
    let first = null;
    const isExec = mode === "exec";
    for (; i < words.length; i++) {
      let w = words[i];
      if (/^\d*[<>]+$/.test(w)) { i++; continue; } // redirect: skip its target too
      if (w === "--") continue;
      if (w.startsWith("-")) {
        const eq = w.indexOf("=");
        const flag = eq > 0 ? w.slice(0, eq) : w;
        if (isExec && PKG_FLAGS.has(flag)) {
          pkgFlagValues.push(eq > 0 ? w.slice(eq + 1) : words[++i]);
        } else if (eq < 0 && VALUE_FLAGS.has(flag)) i++;
        continue;
      }
      if (isExec) {
        first = w;
        break; // everything after it is the program's own arguments
      }
      add(w, redirected);
    }
    if (isExec) {
      for (const p of pkgFlagValues) if (p) add(p, redirected);
      if (pkgFlagValues.length === 0 && first) add(first, redirected);
    }
  }
  return { packages, skipped };
}

// ── the registry ─────────────────────────────────────────────────────────────

const registryUrl = (name, versionOrTag) => `${REGISTRY}${name.replace("/", "%2F")}/${encodeURIComponent(versionOrTag)}`;

/** The npm integrity string for a manifest's dist: sha512 SRI, or the legacy sha1 shasum. */
function distIntegrity(dist) {
  if (typeof dist?.integrity === "string" && dist.integrity) return dist.integrity;
  if (typeof dist?.shasum === "string" && /^[0-9a-f]{40}$/i.test(dist.shasum)) return `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`;
  return null;
}

/**
 * The version manifest for name@(version|tag): the exact version and where its
 * tarball is. Only https://registry.npmjs.org/ tarballs are accepted.
 */
export async function fetchManifest(name, versionOrTag, { fetch: fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const res = await fetchImpl(registryUrl(name, versionOrTag), {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) throw new Error(`the npm registry has no ${name}@${versionOrTag}`);
  if (!res.ok) throw new Error(`the npm registry answered HTTP ${res.status} for ${name}@${versionOrTag}`);
  const m = await res.json();
  if (m?.name !== name || typeof m.version !== "string" || !EXACT_VERSION_RE.test(m.version)) throw new Error("the npm registry returned an unexpected manifest");
  const tarball = m.dist?.tarball;
  if (typeof tarball !== "string" || !tarball.startsWith(REGISTRY)) {
    throw new Error(`the tarball is not served from ${REGISTRY}${typeof tarball === "string" ? ` (it names ${new URL(tarball).host})` : ""}; not downloaded`);
  }
  return { name: m.name, version: m.version, tarball, integrity: distIntegrity(m.dist) };
}

/** Does the SRI string (sha512-<base64>, possibly several) match these bytes? null = no usable hash in it. */
export function integrityMatches(integrity, bytes) {
  if (!integrity) return null;
  let usable = false;
  for (const part of integrity.split(/\s+/).filter(Boolean)) {
    const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(part);
    if (!m) continue;
    usable = true;
    if (createHash(m[1]).update(bytes).digest("base64") === m[2]) return true;
  }
  return usable ? false : null;
}

/** Download a tarball, never holding more than MAX_TARBALL_BYTES (the body is cut off past it). */
export async function downloadTarball(url, { fetch: fetchImpl = fetch, timeoutMs = 60_000, maxBytes = MAX_TARBALL_BYTES } = {}) {
  if (!url.startsWith(REGISTRY)) throw new Error(`not downloading from ${new URL(url).host}; only ${REGISTRY} is accepted`);
  const res = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const tooBig = (n) => new Error(`the tarball is ${n === null ? "larger" : `${n} bytes, larger`} than the ${maxBytes} byte limit; not hashed`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig(declared);
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig(null);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The sha256 of the exact tarball the registry serves for one version, after
 * checking the bytes against the manifest's own integrity (sha512). If the
 * registry's bytes do not match its own integrity, no digest is returned.
 */
export async function digestFromManifest(manifest, opts = {}) {
  const bytes = await downloadTarball(manifest.tarball, opts);
  const m = integrityMatches(manifest.integrity, bytes);
  if (m === false) throw new Error("the tarball the registry served does not match the integrity it records for this version");
  return { sha256: sha256Hex(bytes), integrity_check: m === null ? "not_published" : "match", bytes: bytes.length };
}
