import { redact } from "../redaction.js";

const WINDOWS_ABSOLUTE = /\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/g;
const POSIX_PRIVATE = /(?:\/Users|\/home|\/mnt|\/tmp|\/var\/tmp)\/[^\s"'<>]+/g;
const SESSION_ID = /\b(?:ses_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizePublicText(
  value: unknown,
  privateRoot: string,
): string {
  let text = redact(String(value ?? ""));
  if (privateRoot) {
    text = text.replace(
      new RegExp(escapeRegExp(privateRoot), "gi"),
      "<demo-workspace>",
    );
  }
  text = text.replace(WINDOWS_ABSOLUTE, "<private-path>");
  text = text.replace(POSIX_PRIVATE, "<private-path>");
  text = text.replace(SESSION_ID, "<session-id>");
  return text.slice(0, 8_000);
}
