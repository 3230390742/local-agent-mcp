/**
 * Best-effort masking of sensitive material (tokens, API keys, authorization
 * headers) from strings before they are logged or returned to the caller.
 *
 * This is defense-in-depth, not a guarantee. It targets the most common shapes
 * of leaked secrets: bearer tokens, `key=value` style secrets, and well-known
 * provider key prefixes.
 */

const MASK = "[REDACTED]";

/**
 * Each rule has a regex and a replacement. Replacements preserve the
 * surrounding label (e.g. `Authorization:`) while masking the secret value so
 * that logs remain meaningful.
 */
const RULES: Array<{ re: RegExp; replace: string }> = [
  // Authorization: Bearer <token>  /  Authorization: Basic <token>
  {
    re: /(authorization\s*[:=]\s*)(bearer|basic|token)\s+[A-Za-z0-9._\-+/=]+/gi,
    replace: `$1$2 ${MASK}`,
  },
  // Standalone "Bearer <token>"
  {
    re: /\b(bearer)\s+[A-Za-z0-9._\-+/=]{8,}/gi,
    replace: `$1 ${MASK}`,
  },
  // Provider key prefixes: sk-..., sk-proj-..., ghp_..., gho_..., xoxb-..., AKIA...
  {
    re: /\b(sk-(?:proj-)?[A-Za-z0-9]{16,}|gh[posur]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    replace: MASK,
  },
  // Generic key/token/secret/password assignments:
  //   api_key=..., token: "...", "secret":"...", password=...
  {
    re: /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token|password|passwd|client[_-]?secret)["']?\s*[:=]\s*)(["']?)([^"'\s,}]+)(\2)/gi,
    replace: `$1$2${MASK}$4`,
  },
  // JWTs: three base64url segments separated by dots.
  {
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replace: MASK,
  },
];

/**
 * Returns a copy of `input` with sensitive substrings masked. Non-string input
 * is coerced to string first. Never throws.
 */
export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : String(input);
  for (const { re, replace } of RULES) {
    text = text.replace(re, replace);
  }
  return text;
}
