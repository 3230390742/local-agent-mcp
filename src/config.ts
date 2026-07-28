import { log } from "./logger.js";

/**
 * Central runtime configuration derived from environment variables.
 *
 * All configuration is read once at startup. Values are validated and
 * normalized so the rest of the codebase can rely on well-formed data.
 */
export interface AppConfig {
  /** Absolute, realpath-resolved directories that agents are allowed to touch. */
  allowedRoots: string[];
  /** Whether workspace_write mode is permitted at all. */
  allowWrite: boolean;
  /** Maximum bytes of combined stdout+stderr captured per child process. */
  maxOutputBytes: number;
  /** Maximum number of concurrent agent runs. */
  maxConcurrency: number;
  /** When true, full prompts may be logged to stderr. */
  debug: boolean;
  /** Default timeout (seconds) applied when a tool call omits one. */
  defaultTimeoutSeconds: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 5_000_000; // 5 MB
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_SECONDS = 300;

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    log("warn", `Invalid ${name}="${value}", falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Reads and validates configuration from the environment.
 *
 * `AGENT_ALLOWED_ROOTS` is a comma-separated list of absolute directories.
 * Note: paths are NOT realpath-resolved here (that is done lazily in
 * security.ts against live filesystem state) but they are trimmed and
 * filtered for emptiness. An empty allowlist means no directory is allowed,
 * which is the safe default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawRoots = env.AGENT_ALLOWED_ROOTS ?? "";
  const allowedRoots = rawRoots
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (allowedRoots.length === 0) {
    log(
      "warn",
      "AGENT_ALLOWED_ROOTS is empty. No working directories are permitted; " +
        "all tool calls that require a cwd will be rejected.",
    );
  }

  const config: AppConfig = {
    allowedRoots,
    allowWrite: parseBool(env.AGENT_ALLOW_WRITE),
    maxOutputBytes: parsePositiveInt(
      env.AGENT_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
      "AGENT_MAX_OUTPUT_BYTES",
    ),
    maxConcurrency: parsePositiveInt(
      env.AGENT_MAX_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
      "AGENT_MAX_CONCURRENCY",
    ),
    debug: parseBool(env.AGENT_DEBUG),
    defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };

  return config;
}
