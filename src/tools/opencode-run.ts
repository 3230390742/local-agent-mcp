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
import { parseOpenCodeOutput } from "../parsers/opencode-parser.js";
import { redact } from "../redaction.js";
import { log } from "../logger.js";

/**
 * Zod schema for opencode_run. `auto_approve` maps to OpenCode's `--auto`
 * flag, which allows the agent to perform write/side-effecting actions without
 * prompting; it is therefore treated as a write operation and gated behind
 * AGENT_ALLOW_WRITE.
 */
export const opencodeRunSchema = z
  .object({
    prompt: z.string().min(1, "prompt is required").max(100_000),
    cwd: z.string().min(1, "cwd is required").max(4_096),
    model: z.string().max(200).optional(),
    agent: z.string().max(200).optional(),
    session_id: z.string().max(200).optional(),
    auto_approve: z.boolean().default(false),
    timeout_seconds: z.number().int().min(10).max(3_600).optional(),
    output_mode: z.enum(["final", "events"]).default("final"),
  })
  .strict();

export type OpenCodeRunInput = z.infer<typeof opencodeRunSchema>;

export interface OpenCodeRunResult {
  ok: boolean;
  agent: "opencode";
  cwd: string;
  autoApprove: boolean;
  finalMessage: string | null;
  sessionId: string | null;
  tools: ReturnType<typeof parseOpenCodeOutput>["tools"];
  fileChanges: string[];
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
 * Executes OpenCode non-interactively via:
 *   opencode run --format json --dir <cwd>
 *     [--model <m>] [--agent <a>] [--session <s>] [--auto] <prompt>
 *
 * Security mirrors codex_run: cwd is realpath-authorized; --auto requires
 * AGENT_ALLOW_WRITE and takes a per-directory write lock; all args are array
 * form with shell:false.
 */
export async function runOpenCode(
  input: OpenCodeRunInput,
  ctx: ToolContext,
): Promise<OpenCodeRunResult> {
  let release: (() => void) | undefined;
  let realCwd = input.cwd;
  try {
    checkLength("prompt", input.prompt);
    checkLength("cwd", input.cwd);
    checkLength("model", input.model);
    checkLength("agent", input.agent);
    checkLength("sessionId", input.session_id);

    const resolved = await resolveAndAuthorizeCwd(input.cwd, ctx.config);
    realCwd = resolved.realCwd;

    const isWrite = input.auto_approve;
    if (isWrite) {
      assertWriteAllowed(ctx.config);
    }

    const timeoutSeconds =
      input.timeout_seconds ?? ctx.config.defaultTimeoutSeconds;
    const timeoutMs = timeoutSeconds * 1_000;

    const args = ["run", "--format", "json", "--dir", realCwd];
    if (input.model) args.push("--model", input.model);
    if (input.agent) args.push("--agent", input.agent);
    if (input.session_id) args.push("--session", input.session_id);
    if (input.auto_approve) args.push("--auto");
    // Prompt as the final positional argument.
    args.push(input.prompt);

    if (ctx.config.debug) {
      log("debug", "Running opencode", { cwd: realCwd, prompt: input.prompt, auto: String(isWrite) });
    } else {
      log("info", "Running opencode", { cwd: realCwd, auto: String(isWrite), promptLength: String(input.prompt.length) });
    }

    release = await ctx.concurrency.acquire(isWrite ? realCwd : undefined);

    const resolvedCmd = resolveCommand("opencode");
    if (!resolvedCmd) {
      throw Object.assign(new Error("OpenCode CLI not found on PATH."), {
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

    const parsed = parseOpenCodeOutput(run.stdout);

    if (parsed.errors.length === 0 && run.stderr.trim() && run.exitCode !== 0) {
      parsed.errors.push(redact(run.stderr.trim().slice(0, 2_000)));
    }

    const ok = run.exitCode === 0 && !run.timedOut && parsed.errors.length === 0;

    const result: OpenCodeRunResult = {
      ok,
      agent: "opencode",
      cwd: realCwd,
      autoApprove: isWrite,
      finalMessage: parsed.finalMessage,
      sessionId: parsed.sessionId,
      tools: parsed.tools,
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
          ? `OpenCode timed out after ${timeoutSeconds}s`
          : parsed.errors[0] ?? `OpenCode exited with code ${run.exitCode}`,
      };
    }

    return result;
  } catch (err) {
    return buildSpawnError(err, input, realCwd);
  } finally {
    if (release) release();
  }
}

function buildSpawnError(
  err: unknown,
  input: OpenCodeRunInput,
  cwd: string,
): OpenCodeRunResult {
  const isSecurity = err instanceof SecurityError;
  const code = isSecurity
    ? (err as SecurityError).code
    : (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "opencode_not_found"
      : "spawn_failed";
  const message = isSecurity
    ? (err as SecurityError).message
    : (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "OpenCode CLI not found on PATH. Install it and ensure `opencode` is runnable."
      : redact(String((err as Error)?.message ?? err));
  return {
    ok: false,
    agent: "opencode",
    cwd,
    autoApprove: input.auto_approve,
    finalMessage: null,
    sessionId: null,
    tools: [],
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
