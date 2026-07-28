import { z } from "zod";
import type { ToolContext } from "../context.js";
import { resolveCommand } from "../executable-resolver.js";
import { runProcess } from "../process-runner.js";
import {
  resolveAndAuthorizeCwd,
  assertWriteAllowed,
  checkLength,
  SecurityError,
} from "../security.js";
import { parseCodexOutput } from "../parsers/codex-parser.js";
import { redact } from "../redaction.js";
import { log } from "../logger.js";

/**
 * Zod schema for codex_run. `cwd` must be absolute (validated further in
 * security.ts). `mode` maps to Codex sandbox policies. `output_mode` controls
 * whether raw events are returned alongside the summary.
 */
export const codexRunSchema = z
  .object({
    prompt: z.string().min(1, "prompt is required").max(100_000),
    cwd: z.string().min(1, "cwd is required").max(4_096),
    mode: z.enum(["read_only", "workspace_write"]).default("read_only"),
    model: z.string().max(200).optional(),
    timeout_seconds: z.number().int().min(10).max(3_600).optional(),
    output_mode: z.enum(["final", "events"]).default("final"),
  })
  .strict();

export type CodexRunInput = z.infer<typeof codexRunSchema>;

/** Maps our public mode names to Codex's `--sandbox` values. */
const SANDBOX_MAP: Record<CodexRunInput["mode"], string> = {
  read_only: "read-only",
  workspace_write: "workspace-write",
};

export interface CodexRunResult {
  ok: boolean;
  agent: "codex";
  mode: CodexRunInput["mode"];
  cwd: string;
  finalMessage: string | null;
  threadId: string | null;
  commands: ReturnType<typeof parseCodexOutput>["commands"];
  fileChanges: ReturnType<typeof parseCodexOutput>["fileChanges"];
  errors: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  events?: unknown[];
  error?: { code: string; message: string };
}

/**
 * Executes Codex non-interactively via:
 *   codex exec --ephemeral --json --skip-git-repo-check
 *     --sandbox <mode> -C <cwd> [-m <model>] <prompt>
 *
 * Security:
 *  - cwd is realpath-resolved and confirmed within an allowed root.
 *  - workspace_write requires AGENT_ALLOW_WRITE=true and takes a per-directory
 *    write lock.
 *  - All arguments are passed as an array (shell:false); no shell interpolation.
 *
 * On non-zero exit / timeout, returns ok:false with a structured error rather
 * than throwing.
 */
export async function runCodex(
  input: CodexRunInput,
  ctx: ToolContext,
): Promise<CodexRunResult> {
  // Validation and authorization may throw SecurityError; we convert those into
  // structured results (never throw to the caller) via buildSpawnError.
  let release: (() => void) | undefined;
  let realCwd = input.cwd;
  try {
    checkLength("prompt", input.prompt);
    checkLength("cwd", input.cwd);
    checkLength("model", input.model);

    const resolved = await resolveAndAuthorizeCwd(input.cwd, ctx.config);
    realCwd = resolved.realCwd;

    const isWrite = input.mode === "workspace_write";
    if (isWrite) {
      assertWriteAllowed(ctx.config);
    }

    const timeoutSeconds =
      input.timeout_seconds ?? ctx.config.defaultTimeoutSeconds;
    const timeoutMs = timeoutSeconds * 1_000;

    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      SANDBOX_MAP[input.mode],
      "-C",
      realCwd,
    ];
    if (input.model) {
      args.push("-m", input.model);
    }
    // Terminate options and pass the prompt as the final positional argument.
    args.push(input.prompt);

    if (ctx.config.debug) {
      log("debug", "Running codex", { cwd: realCwd, prompt: input.prompt, mode: input.mode });
    } else {
      log("info", "Running codex", { cwd: realCwd, mode: input.mode, promptLength: String(input.prompt.length) });
    }

    release = await ctx.concurrency.acquire(isWrite ? realCwd : undefined);

    const resolvedCmd = resolveCommand("codex");
    if (!resolvedCmd) {
      throw Object.assign(new Error("Codex CLI not found on PATH."), {
        code: "ENOENT",
      });
    }

    const run = await runProcess({
      command: resolvedCmd.command,
      args: [...resolvedCmd.prefixArgs, ...args],
      cwd: realCwd,
      timeoutMs,
      maxOutputBytes: ctx.config.maxOutputBytes,
    });

    const parsed = parseCodexOutput(run.stdout);

    // Codex prints protocol events on stdout; anything on stderr that looks
    // like an error is captured too (redacted).
    if (parsed.errors.length === 0 && run.stderr.trim() && run.exitCode !== 0) {
      parsed.errors.push(redact(run.stderr.trim().slice(0, 2_000)));
    }

    const ok = run.exitCode === 0 && !run.timedOut && parsed.errors.length === 0;

    const result: CodexRunResult = {
      ok,
      agent: "codex",
      mode: input.mode,
      cwd: realCwd,
      finalMessage: parsed.finalMessage,
      threadId: parsed.threadId,
      commands: parsed.commands,
      fileChanges: parsed.fileChanges,
      errors: parsed.errors.map((e) => redact(e)),
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      truncated: run.truncated,
      durationMs: run.durationMs,
    };

    if (input.output_mode === "events") {
      result.events = parsed.events;
    }

    if (!ok) {
      result.error = {
        code: run.timedOut
          ? "timeout"
          : run.exitCode !== 0
            ? "nonzero_exit"
            : "agent_error",
        message: run.timedOut
          ? `Codex timed out after ${timeoutSeconds}s`
          : parsed.errors[0] ?? `Codex exited with code ${run.exitCode}`,
      };
    }

    return result;
  } catch (err) {
    return buildSpawnError(err, input, realCwd);
  } finally {
    if (release) release();
  }
}

/** Converts a spawn-level failure (e.g. ENOENT) into a structured result. */
function buildSpawnError(
  err: unknown,
  input: CodexRunInput,
  cwd: string,
): CodexRunResult {
  const isSecurity = err instanceof SecurityError;
  const code = isSecurity
    ? (err as SecurityError).code
    : (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "codex_not_found"
      : "spawn_failed";
  const message = isSecurity
    ? (err as SecurityError).message
    : (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "Codex CLI not found on PATH. Install it and ensure `codex` is runnable."
      : redact(String((err as Error)?.message ?? err));
  return {
    ok: false,
    agent: "codex",
    mode: input.mode,
    cwd,
    finalMessage: null,
    threadId: null,
    commands: [],
    fileChanges: [],
    errors: [message],
    exitCode: null,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 0,
    error: { code, message },
  };
}
