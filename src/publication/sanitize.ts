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
const WINDOWS_ROOTED_PATH_PREFIX = /(?:^|[^A-Za-z0-9\\])\\(?!\\)(?=$|\S)/;
const POSIX_PATH_PREFIX = /(?:^|[^A-Za-z0-9/])\/(?=$|\S)/;
const VALID_PERCENT_OCTET = /%[0-9A-Fa-f]{2}/;
const BOUNDARY_PERCENT_ATTEMPT = /(?:^|[^\p{L}\p{N}_])%(?=\S{2})/u;
const ENCODED_WINDOWS_DRIVE_PREFIX = /[A-Za-z]%(?:25){0,7}3A/iu;
const MAX_PERCENT_DECODE_DEPTH = 8;
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
const SENSITIVE_HTTP_PARAMETER_KEY =
  /^(?:(?:api[ _-]?)?key|provider|secret|password|passwd|token|credentials?|(?:proxy[ _-]?)?authorization|(?:(?:user|system|developer)[ _-])?prompt(?:[._-]?(?:input|text|content|value|preview))?|(?:stderr|standard error)(?:[ _-](?:output|stream))?)$/i;

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
    WINDOWS_ROOTED_PATH_PREFIX.test(value) ||
    POSIX_PATH_PREFIX.test(value)
  );
}

function decodePercentEncoded(value: string): string | undefined {
  let decoded = value;

  for (let depth = 0; VALID_PERCENT_OCTET.test(decoded); depth += 1) {
    if (depth === MAX_PERCENT_DECODE_DEPTH) return undefined;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return undefined;
    }
  }

  return BOUNDARY_PERCENT_ATTEMPT.test(decoded) ? undefined : decoded;
}

function hasEncodedAbsoluteFilesystemPathOutsideHttpUrls(value: string): boolean {
  const detectionView = value.replace(ORDINARY_HTTP_URL, "");
  if (
    !BOUNDARY_PERCENT_ATTEMPT.test(detectionView) &&
    !ENCODED_WINDOWS_DRIVE_PREFIX.test(detectionView)
  ) {
    return false;
  }
  const decoded = decodePercentEncoded(detectionView);
  return decoded === undefined || hasAbsoluteFilesystemPath(decoded);
}

function hasFilesystemUrlData(component: string): boolean {
  const decoded = decodePercentEncoded(component);
  if (decoded === undefined) return true;

  if (hasAbsoluteFilesystemPath(decoded)) return true;

  try {
    return [...new URLSearchParams(component)].some(
      ([name, value]) => {
        const decodedName = decodePercentEncoded(name);
        const decodedValue = decodePercentEncoded(value);
        return (
          decodedName === undefined ||
          decodedValue === undefined ||
          SENSITIVE_HTTP_PARAMETER_KEY.test(decodedName) ||
          hasAbsoluteFilesystemPath(decodedName) ||
          hasAbsoluteFilesystemPath(decodedValue)
        );
      },
    );
  } catch {
    return true;
  }
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
    WINDOWS_ROOTED_PATH_PREFIX.test(detectionView) ||
    POSIX_PATH_PREFIX.test(detectionView) ||
    hasEncodedAbsoluteFilesystemPathOutsideHttpUrls(line)
  );
}

function hasSensitiveLabelsOutsideHttpUrls(line: string): boolean {
  const detectionView = line.replace(ORDINARY_HTTP_URL, "");
  return (
    AUTHORIZATION_KEY.test(detectionView) ||
    STDERR_KEY.test(detectionView) ||
    (PROMPT_KEY.test(detectionView) && !REVIEWED_PROMPT_STATUS.test(detectionView))
  );
}

function redactOutsideHttpUrls(text: string): string {
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(ORDINARY_HTTP_URL)) {
    const index = match.index ?? cursor;
    result += redact(text.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }

  return result + redact(text.slice(cursor));
}

function neutralizeSensitiveLines(text: string, usernames: string[]): string {
  return text.replace(/[^\r\n]+/g, (line) =>
    URI_USERINFO.test(line) ||
    LOCAL_FILE_URI.test(line) ||
    hasAbsoluteLocalPath(line) ||
    hasSensitiveHttpUrl(line, usernames) ||
    SESSION_OR_THREAD_KEY.test(line) ||
    hasSensitiveLabelsOutsideHttpUrls(line)
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
  text = redactOutsideHttpUrls(text);
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
