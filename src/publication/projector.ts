import type { AgentCompareResult } from "../tools/agent-compare.js";
import { PUBLIC_COMPARISON_NOTE, type PublicAgentRun } from "./schema.js";
import { sanitizePublicText } from "./sanitize.js";

const PUBLIC_ERROR_SUMMARY = "Agent execution details are unavailable.";

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
    errors: run?.errors.length || entry.error ? [PUBLIC_ERROR_SUMMARY] : [],
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
    errors: run?.errors.length || entry.error ? [PUBLIC_ERROR_SUMMARY] : [],
  };
}

export function projectComparison(
  result: AgentCompareResult,
  privateRoot: string,
) {
  return {
    note: PUBLIC_COMPARISON_NOTE,
    codex: projectCodex(result, privateRoot),
    opencode: projectOpenCode(result, privateRoot),
  };
}
