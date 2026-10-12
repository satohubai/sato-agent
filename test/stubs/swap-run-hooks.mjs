// Test only: resolve src/swap/run.js to the stub beside this file.
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith("/src/swap/run.js")) return { ...resolved, url: new URL("./swap-run-stub.mjs", import.meta.url).href };
  return resolved;
}
