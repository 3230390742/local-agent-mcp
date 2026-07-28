import { redact } from "../redaction.js";

const WINDOWS_ABSOLUTE = /\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/g;
const POSIX_ABSOLUTE = /(^|[^A-Za-z0-9/])\/[^\s"'<>|]+/gm;
const UNC_ABSOLUTE = /\\\\[^\s"'<>|\\]+(?:\\[^\s"'<>|\\]+)+/g;
const SESSION_ID = /\b(?:ses_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localUsernames(privateRoot: string): string[] {
  const usernames = new Set<string>();
  const windowsMatch = /(?:^|\\)Users\\([^\\]+)/i.exec(privateRoot);
  const posixMatch = /(?:^|\/)(?:home|Users)\/([^/]+)/i.exec(privateRoot);

  if (windowsMatch?.[1]) usernames.add(windowsMatch[1]);
  if (posixMatch?.[1]) usernames.add(posixMatch[1]);
  return [...usernames];
}

function redactUsername(text: string, username: string): string {
  const token = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(username)}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(token, "$1<local-username>");
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
  text = text.replace(POSIX_ABSOLUTE, "$1<private-path>");
  text = text.replace(UNC_ABSOLUTE, "<private-path>");
  for (const username of localUsernames(privateRoot)) {
    text = redactUsername(text, username);
  }
  text = text.replace(SESSION_ID, "<session-id>");
  return text.slice(0, 8_000);
}
