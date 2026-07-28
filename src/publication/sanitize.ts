import { userInfo } from "node:os";
import { redact } from "../redaction.js";

const WINDOWS_ABSOLUTE = /[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*/g;
const UNC_ABSOLUTE = /\\\\[^\s"'<>|\\]+(?:\\[^\s"'<>|\\]+)+/g;
const SESSION_ID = /\b(?:ses_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi;
const AUTHORIZATION_KEY = /["']?(?:proxy[ _-])?authorization["']?\s*[:=]/i;
const URI_USERINFO = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]*@/i;
const LOCAL_FILE_URI = /\bfile:\/\//i;
const ORDINARY_HTTP_URL = /\bhttps?:\/\/[^\s"'<>|]+/gi;
const WINDOWS_PATH_PREFIX = /[A-Za-z]:\\/;
const UNC_PATH_PREFIX = /\\\\/;
const POSIX_PATH_PREFIX = /(?:^|[^A-Za-z0-9/])\/+(?=\S)/;
const SESSION_OR_THREAD_KEY =
  /(?:["']?(?:session|thread)(?:[ _.-]?(?:id|identifier))?["']?\s*[:=]|["']?(?:session|thread)[ _.-]?(?:id|identifier)["']?\s+\S)/i;
const STDERR_KEY =
  /\b(?:stderr|standard error)(?:[ _-](?:output|stream)(?:\s*\([^\r\n()]{1,80}\))?)?\s*[:=-]/i;
const PROMPT_KEY =
  /\b(?:(?:user|system|developer)[ _-])?prompt(?:[._-]?(?:input|text|content|value|preview))?(?:\s*[:=-]|\s+\S)/i;
const REVIEWED_PROMPT_STATUS =
  /^\s*prompt(?:\s+review)?\s+(?:complete|passed|approved)\.?\s*$/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----|$)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localUsernames(privateRoot: string): string[] {
  const usernames = new Set<string>();
  const windowsMatch = /(?:^|\\)Users\\([^\\]+)/i.exec(privateRoot);
  const posixMatch = /(?:^|\/)(?:home|Users)\/([^/]+)/i.exec(privateRoot);
  let osUsername: string | undefined;

  try {
    osUsername = userInfo().username;
  } catch {
    osUsername = undefined;
  }

  if (windowsMatch?.[1]) usernames.add(windowsMatch[1]);
  if (posixMatch?.[1]) usernames.add(posixMatch[1]);
  if (osUsername) usernames.add(osUsername);
  if (process.env.USERNAME) usernames.add(process.env.USERNAME);
  if (process.env.USER) usernames.add(process.env.USER);
  return [...usernames];
}

function redactUsername(text: string, username: string): string {
  const token = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(username)}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(token, "$1<local-username>");
}

function hasAbsoluteFilesystemPath(value: string): boolean {
  return (
    WINDOWS_PATH_PREFIX.test(value) ||
    UNC_PATH_PREFIX.test(value) ||
    POSIX_PATH_PREFIX.test(value)
  );
}

function hasFilesystemUrlData(component: string): boolean {
  if (component.startsWith("/") && hasAbsoluteFilesystemPath(component)) {
    return true;
  }

  return [...new URLSearchParams(component)].some(([, value]) =>
    hasAbsoluteFilesystemPath(value),
  );
}

function hasSensitiveHttpUrl(text: string, usernames: string[]): boolean {
  for (const match of text.matchAll(ORDINARY_HTTP_URL)) {
    const rawUrl = match[0];
    if (usernames.some((username) => redactUsername(rawUrl, username) !== rawUrl)) {
      return true;
    }

    try {
      const url = new URL(rawUrl);
      if (
        hasFilesystemUrlData(url.search) ||
        hasFilesystemUrlData(url.hash.slice(1))
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

function hasAbsoluteLocalPath(line: string): boolean {
  const detectionView = line.replace(ORDINARY_HTTP_URL, "");
  return (
    WINDOWS_PATH_PREFIX.test(detectionView) ||
    UNC_PATH_PREFIX.test(detectionView) ||
    POSIX_PATH_PREFIX.test(detectionView)
  );
}

function neutralizeSensitiveLines(text: string, usernames: string[]): string {
  return text.replace(/[^\r\n]+/g, (line) =>
    AUTHORIZATION_KEY.test(line) ||
    URI_USERINFO.test(line) ||
    LOCAL_FILE_URI.test(line) ||
    hasAbsoluteLocalPath(line) ||
    hasSensitiveHttpUrl(line, usernames) ||
    SESSION_OR_THREAD_KEY.test(line) ||
    STDERR_KEY.test(line) ||
    (PROMPT_KEY.test(line) && !REVIEWED_PROMPT_STATUS.test(line))
      ? "[REDACTED]"
      : line,
  );
}

export function sanitizePublicText(
  value: unknown,
  privateRoot: string,
): string {
  const usernames = localUsernames(privateRoot);
  let text = String(value ?? "").replace(PRIVATE_KEY_BLOCK, "[REDACTED]");
  text = neutralizeSensitiveLines(text, usernames);
  text = redact(text);
  if (privateRoot) {
    text = text.replace(
      new RegExp(escapeRegExp(privateRoot), "gi"),
      "<demo-workspace>",
    );
  }
  text = text.replace(WINDOWS_ABSOLUTE, "<private-path>");
  text = text.replace(UNC_ABSOLUTE, "<private-path>");
  for (const username of usernames) {
    text = redactUsername(text, username);
  }
  text = text.replace(SESSION_ID, "<session-id>");
  return text.slice(0, 8_000);
}
