/**
 * Parser for Codex CLI `--json` (JSONL) output.
 *
 * Codex has shipped several event schemas over its lifetime. This parser
 * handles the two most relevant families and degrades gracefully on unknown
 * shapes:
 *
 *  A) Thread/turn/item format (Codex >= ~0.4x), e.g.:
 *       {"type":"thread.started","thread_id":"..."}
 *       {"type":"turn.started"}
 *       {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *       {"type":"item.completed","item":{"type":"command_execution",
 *          "command":"...","exit_code":0,"aggregated_output":"..."}}
 *       {"type":"item.completed","item":{"type":"file_change","changes":[...]}}
 *       {"type":"turn.completed","usage":{...}}
 *       {"type":"turn.failed","error":{"message":"..."}}
 *       {"type":"error","message":"..."}
 *
 *  B) Legacy msg format:
 *       {"msg":{"type":"agent_message","message":"..."}}
 *       {"msg":{"type":"exec_command_begin","command":[...]}}
 *       {"msg":{"type":"error","message":"..."}}
 *
 * The parser never throws on malformed lines; unparseable lines are collected
 * so callers can surface them if nothing else was extracted.
 */

export interface CommandEvent {
  command: string;
  exitCode?: number;
  status?: string;
  outputPreview?: string;
}

export interface FileChangeEvent {
  path: string;
  kind?: string;
}

export interface CodexParseResult {
  /** The final agent message text, if one was produced. */
  finalMessage: string | null;
  /** Session / thread identifier, if present. */
  threadId: string | null;
  /** Summaries of command executions the agent performed. */
  commands: CommandEvent[];
  /** File modifications reported by the agent. */
  fileChanges: FileChangeEvent[];
  /** Error messages extracted from error / turn.failed events. */
  errors: string[];
  /** Raw parsed event objects (for output_mode="events"). */
  events: unknown[];
  /** Lines that could not be parsed as JSON. */
  unparsedLines: string[];
}

const OUTPUT_PREVIEW_LIMIT = 2_000;

function truncate(text: string, limit = OUTPUT_PREVIEW_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) + "…[truncated]" : text;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function itemType(item: Record<string, unknown>): string | undefined {
  return asString(item.type) ?? asString(item.item_type);
}

function extractCommand(item: Record<string, unknown>): CommandEvent {
  const raw = item.command;
  const command = Array.isArray(raw)
    ? raw.map((c) => String(c)).join(" ")
    : asString(raw) ?? "";
  const outputRaw =
    asString(item.aggregated_output) ??
    asString(item.output) ??
    asString(item.stdout);
  const exitCode =
    typeof item.exit_code === "number" ? item.exit_code : undefined;
  return {
    command,
    exitCode,
    status: asString(item.status),
    outputPreview: outputRaw ? truncate(outputRaw) : undefined,
  };
}

function extractFileChanges(item: Record<string, unknown>): FileChangeEvent[] {
  const changes = item.changes;
  const out: FileChangeEvent[] = [];
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        const p = asString(obj.path) ?? asString(obj.file);
        if (p) out.push({ path: p, kind: asString(obj.kind) ?? asString(obj.type) });
      } else if (typeof c === "string") {
        out.push({ path: c });
      }
    }
  } else {
    const p = asString(item.path) ?? asString(item.file);
    if (p) out.push({ path: p, kind: asString(item.kind) });
  }
  return out;
}

/**
 * Parses a full Codex JSONL string into a structured result.
 */
export function parseCodexOutput(raw: string): CodexParseResult {
  const result: CodexParseResult = {
    finalMessage: null,
    threadId: null,
    commands: [],
    fileChanges: [],
    errors: [],
    events: [],
    unparsedLines: [],
  };

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
    if (!evt || typeof evt !== "object") {
      result.unparsedLines.push(trimmed);
      continue;
    }
    result.events.push(evt);

    const obj = evt as Record<string, unknown>;
    const type = asString(obj.type);

    // Thread id (format A).
    if (type === "thread.started") {
      result.threadId = asString(obj.thread_id) ?? result.threadId;
      continue;
    }

    // Errors (format A).
    if (type === "error") {
      const m = asString(obj.message);
      if (m) result.errors.push(m);
      continue;
    }
    if (type === "turn.failed") {
      const err = obj.error;
      if (err && typeof err === "object") {
        const m = asString((err as Record<string, unknown>).message);
        if (m) result.errors.push(m);
      }
      continue;
    }

    // Item events (format A).
    if (type === "item.completed" || type === "item.started" || type === "item.updated") {
      const item = obj.item;
      if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const kind = itemType(it);
        if (kind === "agent_message" || kind === "assistant_message") {
          const text = asString(it.text) ?? asString(it.message);
          if (text) result.finalMessage = text;
        } else if (kind === "command_execution" || kind === "exec_command") {
          if (type === "item.completed") result.commands.push(extractCommand(it));
        } else if (kind === "file_change" || kind === "patch_apply") {
          result.fileChanges.push(...extractFileChanges(it));
        } else if (kind === "error") {
          const m = asString(it.message) ?? asString(it.text);
          if (m) result.errors.push(m);
        }
      }
      continue;
    }

    // Legacy msg format (format B).
    const msg = obj.msg;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const mtype = asString(m.type);
      if (mtype === "agent_message") {
        const text = asString(m.message) ?? asString(m.text);
        if (text) result.finalMessage = text;
      } else if (mtype === "exec_command_begin" || mtype === "exec_command_end") {
        result.commands.push(extractCommand(m));
      } else if (mtype === "patch_apply_begin" || mtype === "apply_patch") {
        result.fileChanges.push(...extractFileChanges(m));
      } else if (mtype === "error") {
        const em = asString(m.message);
        if (em) result.errors.push(em);
      }
      continue;
    }

    // Some versions place the thread id at top level under session_id.
    if (result.threadId === null) {
      result.threadId = asString(obj.session_id) ?? null;
    }
  }

  return result;
}
