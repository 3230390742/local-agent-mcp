import { redact } from "../redaction.js";

const WINDOWS_ABSOLUTE = /\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/g;
const UNC_ABSOLUTE = /\\\\[^\s"'<>|\\]+(?:\\[^\s"'<>|\\]+)+/g;
const SESSION_ID = /\b(?:ses_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi;
const AUTHORIZATION_KEY = /["']?authorization["']?\s*[:=]/i;
const URI_USERINFO = /\bhttps?:\/\/[^\s/@]*@/i;
const ORDINARY_HTTP_URL = /\bhttps?:\/\/[^\s"'<>|]+/gi;
const WINDOWS_PATH_PREFIX = /\b[A-Za-z]:\\/;
const UNC_PATH_PREFIX = /\\\\/;
const POSIX_PATH_PREFIX = /(?:^|[^A-Za-z0-9/])\/(?![/\s])/;
const SESSION_OR_THREAD_KEY = /["']?(?:session|thread)(?:[ _-]?id)?["']?\s*[:=]/i;
const STDERR_KEY = /\bstderr\s*[:=]/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g;

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

function hasAbsoluteLocalPath(line: string): boolean {
  const detectionView = line.replace(ORDINARY_HTTP_URL, "");
  return (
    WINDOWS_PATH_PREFIX.test(detectionView) ||
    UNC_PATH_PREFIX.test(detectionView) ||
    POSIX_PATH_PREFIX.test(detectionView)
  );
}

function neutralizeSensitiveLines(text: string): string {
  return text.replace(/[^\r\n]+/g, (line) =>
    AUTHORIZATION_KEY.test(line) ||
    URI_USERINFO.test(line) ||
    hasAbsoluteLocalPath(line) ||
    SESSION_OR_THREAD_KEY.test(line) ||
    STDERR_KEY.test(line)
      ? "[REDACTED]"
      : line,
  );
}

export function sanitizePublicText(
  value: unknown,
  privateRoot: string,
): string {
  let text = String(value ?? "").replace(PRIVATE_KEY_BLOCK, "[REDACTED]");
  text = neutralizeSensitiveLines(text);
  text = redact(text);
  if (privateRoot) {
    text = text.replace(
      new RegExp(escapeRegExp(privateRoot), "gi"),
      "<demo-workspace>",
    );
  }
  text = text.replace(WINDOWS_ABSOLUTE, "<private-path>");
  text = text.replace(UNC_ABSOLUTE, "<private-path>");
  for (const username of localUsernames(privateRoot)) {
    text = redactUsername(text, username);
  }
  text = text.replace(SESSION_ID, "<session-id>");
  return text.slice(0, 8_000);
}
