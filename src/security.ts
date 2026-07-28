import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";

/**
 * Error thrown when a path fails validation against the allowlist. Carries a
 * machine-readable `code` so tools can map it to a structured MCP error.
 */
export class SecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
  }
}

/** Upper bounds on user-supplied string inputs to avoid abuse / DoS. */
export const LIMITS = {
  prompt: 100_000,
  cwd: 4_096,
  model: 200,
  agent: 200,
  sessionId: 200,
} as const;

/**
 * Validates that a string does not exceed its configured limit. Throws a
 * SecurityError with code "input_too_long" otherwise.
 */
export function checkLength(
  field: keyof typeof LIMITS,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const max = LIMITS[field];
  if (value.length > max) {
    throw new SecurityError(
      "input_too_long",
      `Field "${field}" exceeds maximum length of ${max} characters (got ${value.length}).`,
    );
  }
}

/**
 * Determines whether `child` is equal to or nested within `parent`. Both paths
 * must already be absolute and normalized (ideally realpath-resolved). Uses
 * path.relative so it is correct on both POSIX and Windows (including drive
 * letters and case-insensitive comparisons handled by the caller).
 */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  // Nested when relative path does not start with ".." and is not absolute.
  return (
    rel === "" ||
    (!rel.startsWith("..") && !path.isAbsolute(rel))
  );
}

/**
 * Normalizes a path for comparison. On Windows, drive-letter case and slash
 * direction differ across sources, so we lowercase and let path.normalize fix
 * separators. On POSIX the string is returned normalized as-is.
 */
function normForCompare(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

export interface ResolvedCwd {
  /** The realpath-resolved absolute working directory. */
  realCwd: string;
  /** The allowed root (realpath-resolved) that contains realCwd. */
  matchedRoot: string;
}

/**
 * Resolves and validates a requested working directory against the allowlist.
 *
 * Steps:
 *  1. Require a non-empty, absolute path (rejects relative paths outright).
 *  2. Enforce the length limit.
 *  3. realpath() the requested directory AND each allowed root so that
 *     symlinks are fully resolved. This defeats symlink-escape attacks where a
 *     directory inside an allowed root points outside of it.
 *  4. Confirm the resolved directory lies within at least one resolved root.
 *
 * @throws SecurityError with codes: invalid_cwd, cwd_not_absolute,
 *   input_too_long, cwd_not_found, no_allowed_roots, cwd_outside_allowed.
 */
export async function resolveAndAuthorizeCwd(
  requestedCwd: string,
  config: AppConfig,
): Promise<ResolvedCwd> {
  if (typeof requestedCwd !== "string" || requestedCwd.trim() === "") {
    throw new SecurityError("invalid_cwd", "cwd must be a non-empty string.");
  }
  checkLength("cwd", requestedCwd);

  if (!path.isAbsolute(requestedCwd)) {
    throw new SecurityError(
      "cwd_not_absolute",
      `cwd must be an absolute path. Received: ${requestedCwd}`,
    );
  }

  if (config.allowedRoots.length === 0) {
    throw new SecurityError(
      "no_allowed_roots",
      "No allowed roots configured. Set AGENT_ALLOWED_ROOTS to a comma-separated list of absolute directories.",
    );
  }

  // Resolve the requested directory through the real filesystem (follows
  // symlinks). If it does not exist, this throws and we surface a clean error.
  let realCwd: string;
  try {
    realCwd = await realpath(requestedCwd);
  } catch {
    throw new SecurityError(
      "cwd_not_found",
      `Working directory does not exist or is not accessible: ${requestedCwd}`,
    );
  }

  // Resolve each allowed root the same way. Roots that cannot be resolved
  // (missing dirs) are skipped rather than failing the whole request.
  for (const root of config.allowedRoots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isWithin(normForCompare(realRoot), normForCompare(realCwd))) {
      return { realCwd, matchedRoot: realRoot };
    }
  }

  throw new SecurityError(
    "cwd_outside_allowed",
    `Working directory is outside all allowed roots: ${requestedCwd}`,
  );
}

/**
 * Validates that write access is permitted globally. Called before any
 * workspace_write invocation. Throws SecurityError("write_not_allowed") when
 * AGENT_ALLOW_WRITE is not enabled.
 */
export function assertWriteAllowed(config: AppConfig): void {
  if (!config.allowWrite) {
    throw new SecurityError(
      "write_not_allowed",
      "Write mode is disabled. Set AGENT_ALLOW_WRITE=true to permit workspace_write.",
    );
  }
}
