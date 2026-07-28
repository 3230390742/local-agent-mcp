import { z } from "zod";
import type { ToolContext } from "../context.js";
import { runCodex, type CodexRunResult } from "./codex-run.js";
import { runOpenCode, type OpenCodeRunResult } from "./opencode-run.js";

/**
 * Zod schema for agent_compare. This tool is READ-ONLY by design: it never
 * enables write mode for either agent, regardless of global configuration. It
 * exists to gather two independent analyses of the same prompt.
 */
export const agentCompareSchema = z
  .object({
    prompt: z.string().min(1, "prompt is required").max(100_000),
    cwd: z.string().min(1, "cwd is required").max(4_096),
    codex_model: z.string().max(200).optional(),
    opencode_model: z.string().max(200).optional(),
    timeout_seconds: z.number().int().min(10).max(3_600).optional(),
    parallel: z.boolean().default(true),
  })
  .strict();

export type AgentCompareInput = z.infer<typeof agentCompareSchema>;

interface ComparisonEntry<T> {
  ok: boolean;
  durationMs: number;
  exitStatus: { exitCode: number | null; signal: string | null; timedOut: boolean };
  result: T | null;
  error?: { code: string; message: string };
}

export interface AgentCompareResult {
  prompt_preview: string;
  cwd: string;
  parallel: boolean;
  /**
   * Note: This tool intentionally does NOT judge which agent performed better.
   * It returns both results verbatim so the calling model (Claude Code) can
   * synthesize its own conclusion.
   */
  note: string;
  codex: ComparisonEntry<CodexRunResult>;
  opencode: ComparisonEntry<OpenCodeRunResult>;
}

const NOTE =
  "Both agent results are returned as-is. This tool does not rank or judge " +
  "them; the calling model should synthesize the final assessment.";

/**
 * Runs Codex and OpenCode against the same prompt in read-only mode and returns
 * both results independently. If one agent fails, the other's result is still
 * returned. Supports sequential or parallel execution.
 *
 * The concurrency manager still governs total in-flight runs; requesting
 * parallel execution here may still be serialized by AGENT_MAX_CONCURRENCY.
 */
export async function runAgentCompare(
  input: AgentCompareInput,
  ctx: ToolContext,
): Promise<AgentCompareResult> {
  const codexInput = {
    prompt: input.prompt,
    cwd: input.cwd,
    mode: "read_only" as const,
    model: input.codex_model,
    timeout_seconds: input.timeout_seconds,
    output_mode: "final" as const,
  };
  const opencodeInput = {
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.opencode_model,
    auto_approve: false,
    timeout_seconds: input.timeout_seconds,
    output_mode: "final" as const,
  };

  // settle helpers convert throw/resolve into a uniform entry so one agent's
  // failure never prevents returning the other's result.
  const runCodexSettled = async (): Promise<ComparisonEntry<CodexRunResult>> => {
    try {
      const r = await runCodex(codexInput, ctx);
      return {
        ok: r.ok,
        durationMs: r.durationMs,
        exitStatus: { exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut },
        result: r,
        error: r.error,
      };
    } catch (err) {
      return {
        ok: false,
        durationMs: 0,
        exitStatus: { exitCode: null, signal: null, timedOut: false },
        result: null,
        error: { code: "exception", message: String((err as Error)?.message ?? err) },
      };
    }
  };

  const runOpenCodeSettled = async (): Promise<ComparisonEntry<OpenCodeRunResult>> => {
    try {
      const r = await runOpenCode(opencodeInput, ctx);
      return {
        ok: r.ok,
        durationMs: r.durationMs,
        exitStatus: { exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut },
        result: r,
        error: r.error,
      };
    } catch (err) {
      return {
        ok: false,
        durationMs: 0,
        exitStatus: { exitCode: null, signal: null, timedOut: false },
        result: null,
        error: { code: "exception", message: String((err as Error)?.message ?? err) },
      };
    }
  };

  let codexEntry: ComparisonEntry<CodexRunResult>;
  let opencodeEntry: ComparisonEntry<OpenCodeRunResult>;

  if (input.parallel) {
    [codexEntry, opencodeEntry] = await Promise.all([
      runCodexSettled(),
      runOpenCodeSettled(),
    ]);
  } else {
    codexEntry = await runCodexSettled();
    opencodeEntry = await runOpenCodeSettled();
  }

  return {
    prompt_preview: input.prompt.slice(0, 120),
    cwd: input.cwd,
    parallel: input.parallel,
    note: NOTE,
    codex: codexEntry,
    opencode: opencodeEntry,
  };
}
