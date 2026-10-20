// Test only: the kit pins Sato Hub's real signing key (src/hub-signature.js PINNED_HUB_KEYS). A spawned CLI that is served a
// JWKS made from a throwaway test key (test/purchase-preload.js, SATO_TEST_HUB.jwks) would be refused, so for that process only
// the test keys are added to the pinned set by rewriting the module's source as it is loaded. Nothing in src/ knows about this.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/src/hub-signature.js")) return result;
  let jwks;
  try {
    jwks = JSON.parse(process.env.SATO_TEST_HUB || "{}").jwks;
  } catch {
    jwks = null;
  }
  const extra = (jwks?.keys ?? []).map((k) => `${JSON.stringify(k.kid)}: ${JSON.stringify(k.x)},`).join(" ");
  const marker = "export const PINNED_HUB_KEYS = Object.freeze({";
  const source = String(result.source);
  if (!extra || !source.includes(marker)) return result;
  return { ...result, source: source.replace(marker, `${marker} ${extra}`) };
}
