// Text that came from somewhere else (a server, the chain, the registry, an
// error that echoes server input) is shown and stored as plain, short text.

/** One line: control characters, zero-width and bidi marks, and line/paragraph separators all become a space. */
export function clean(value, max = 200) {
  const s = String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** `clean`, but null/undefined stay null (for optional fields). */
export const cleanOrNull = (value, max = 200) => (value === null || value === undefined ? null : clean(value, max));

/**
 * A response body for the terminal: keeps its lines and tabs, drops every other
 * control or format character (so no terminal escape sequence or bidi trick
 * survives). It is still untrusted content, framed as such by the caller.
 */
export function cleanBody(value) {
  return String(value).replace(/\r\n?/g, "\n").replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}
