/**
 * Parser for OpenCode CLI `run --format json` output.
 *
 * OpenCode streams newline-delimited JSON events. Observed shapes:
 *
 *   {"type":"step_start","sessionID":"ses_...","part":{...}}
 *   {"type":"text","sessionID":"ses_...","part":{"type":"text","text":"Hi",...}}
 *   {"type":"step_finish","sessionID":"ses_...","part":{"tokens":{...},...}}
 *
 * Tool invocations (which is how OpenCode edits files / runs commands) appear
 * as tool parts. Because the exact tool event schema varies by version, this
 * parser extracts tool/file/command information defensively from any event
 * whose part.type indicates a tool, and treats `error` events / parts as
 * errors.
 *
 * The final assistant text is the concatenation of all `text` part fragments
 * (OpenCode may stream text in multiple parts).
 */

export interface OpenCodeToolEvent {
  tool: string;
  status?: string;
  target?: string;
}

export interface OpenCodeParseResult {
  /** Concatenated final assistant text. */
  finalMessage: string | null;
  /** Session id (ses_...), if present. */
  sessionId: string | null;
  /** Tool invocations observed. */
  tools: OpenCodeToolEvent[];
  /** File paths that were modified (best-effort, derived from tool inputs). */
  fileChanges: string[];
  /** Error messages extracted from error events. */
  errors: string[];
  /** Raw parsed events (for output_mode="events"). */
  events: unknown[];
  /** Lines that could not be parsed as JSON. */
  unparsedLines: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

const FILE_TOOLS = new Set(["edit", "write", "patch", "apply", "multiedit"]);

/**
 * Attempts to pull a file path out of a tool part's input/state. Handles the
 * common `state.input.filePath` / `input.path` shapes without assuming a fixed
 * schema.
 */
function extractToolTarget(part: Record<string, unknown>): string | undefined {
  const state = asRecord(part.state);
  const input =
    asRecord(part.input) ?? (state ? asRecord(state.input) : undefined);
  if (input) {
    return (
      asString(input.filePath) ??
      asString(input.path) ??
      asString(input.file) ??
      asString(input.command)
    );
  }
  return undefined;
}

/**
 * Parses a full OpenCode JSON event stream into a structured result.
 */
export function parseOpenCodeOutput(raw: string): OpenCodeParseResult {
  const result: OpenCodeParseResult = {
    finalMessage: null,
    sessionId: null,
    tools: [],
    fileChanges: [],
    errors: [],
    events: [],
    unparsedLines: [],
  };

  const textFragments: string[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      result.unparsedLines.push(trimmed);
      continue;
    }
    const obj = asRecord(evt);
    if (!obj) {
      result.unparsedLines.push(trimmed);
      continue;
    }
    result.events.push(evt);

    // Session id may appear on any event.
    if (result.sessionId === null) {
      result.sessionId = asString(obj.sessionID) ?? asString(obj.sessionId) ?? null;
    }

    const type = asString(obj.type);
    const part = asRecord(obj.part);

    if (type === "text") {
      const text = part ? asString(part.text) : asString(obj.text);
      if (text) textFragments.push(text);
      continue;
    }

    if (type === "error" || (part && asString(part.type) === "error")) {
      const msg =
        asString(obj.message) ??
        (part
          ? asString(part.error) ?? asString(part.message)
          : undefined) ??
        (asRecord(obj.error) ? asString(asRecord(obj.error)!.message) : undefined);
      if (msg) result.errors.push(msg);
      continue;
    }

    // Tool events: type "tool" or a part whose type is "tool".
    const partType = part ? asString(part.type) : undefined;
    if (type === "tool" || partType === "tool") {
      const toolPart = part ?? obj;
      const toolName =
        asString(toolPart.tool) ??
        asString(toolPart.name) ??
        "unknown";
      const state = asRecord(toolPart.state);
      const status = state ? asString(state.status) : asString(toolPart.status);
      const target = extractToolTarget(toolPart);
      result.tools.push({ tool: toolName, status, target });
      if (FILE_TOOLS.has(toolName.toLowerCase()) && target) {
        result.fileChanges.push(target);
      }
      continue;
    }
  }

  if (textFragments.length > 0) {
    result.finalMessage = textFragments.join("");
  }

  return result;
}
