import type { AgentCompareResult } from "../tools/agent-compare.js";
import type { PublicAgentRun } from "./schema.js";
import { sanitizePublicText } from "./sanitize.js";

function projectCodex(
  result: AgentCompareResult,
  privateRoot: string,
): PublicAgentRun {
  const entry = result.codex;
  const run = entry.result;
  return {
    agent: "codex",
    status: entry.ok ? "passed" : "failed",
    durationMs: Math.max(0, Math.round(entry.durationMs)),
    finalMessage: run?.finalMessage
      ? sanitizePublicText(run.finalMessage, privateRoot)
      : null,
    activity: {
      commands: run?.commands.length ?? 0,
      files: run?.fileChanges.length ?? 0,
    },
    errors: (run?.errors ?? (entry.error ? [entry.error.message] : []))
      .slice(0, 10)
      .map((value) =>
        sanitizePublicText(value, privateRoot).slice(0, 1_000),
      ),
  };
}

function projectOpenCode(
  result: AgentCompareResult,
  privateRoot: string,
): PublicAgentRun {
  const entry = result.opencode;
  const run = entry.result;
  return {
    agent: "opencode",
    status: entry.ok ? "passed" : "failed",
    durationMs: Math.max(0, Math.round(entry.durationMs)),
    finalMessage: run?.finalMessage
      ? sanitizePublicText(run.finalMessage, privateRoot)
      : null,
    activity: {
      commands: run?.tools.length ?? 0,
      files: run?.fileChanges.length ?? 0,
    },
    errors: (run?.errors ?? (entry.error ? [entry.error.message] : []))
      .slice(0, 10)
      .map((value) =>
        sanitizePublicText(value, privateRoot).slice(0, 1_000),
      ),
  };
}

export function projectComparison(
  result: AgentCompareResult,
  privateRoot: string,
) {
  return {
    note: "Results are shown without ranking; model output is not a benchmark." as const,
    codex: projectCodex(result, privateRoot),
    opencode: projectOpenCode(result, privateRoot),
  };
}
