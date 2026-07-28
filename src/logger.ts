import { redact } from "./redaction.js";

/**
 * Log levels in increasing severity. All log output is written to stderr so
 * that stdout remains a clean channel for the MCP JSON-RPC protocol.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: LogLevel = "info";

/**
 * Sets the minimum level that will be emitted. When AGENT_DEBUG is enabled the
 * server calls this with "debug".
 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Writes a structured log line to stderr. Never writes to stdout.
 *
 * The message and any structured fields are passed through redaction so that
 * tokens, API keys, and authorization headers are masked defensively.
 */
export function log(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: redact(message),
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      entry[key] =
        typeof value === "string" ? redact(value) : value;
    }
  }

  process.stderr.write(JSON.stringify(entry) + "\n");
}
