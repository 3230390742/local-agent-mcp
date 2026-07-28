import { z } from "zod";
import type { ToolContext } from "../context.js";
import { probeVersion, describeExecutable } from "../context.js";

/** agent_health takes no parameters. */
export const agentHealthSchema = z.object({}).strict();

export interface AgentHealthResult {
  nodeVersion: string;
  gitAvailable: boolean;
  codexInstalled: boolean;
  codexVersion: string | null;
  opencodeInstalled: boolean;
  opencodeVersion: string | null;
  allowedRoots: string[];
  writeAllowed: boolean;
  activeTasks: number;
  maxConcurrency: number;
  platform: string;
  executables: {
    codex: string;
    opencode: string;
  };
}

/**
 * Gathers a health snapshot of the local agent environment: runtime versions,
 * whether Codex/OpenCode/Git are installed, the configured allowlist, and the
 * current concurrency state. Performs no filesystem mutation.
 */
export async function runAgentHealth(
  ctx: ToolContext,
): Promise<AgentHealthResult> {
  const [git, codexVersion, opencodeVersion] = await Promise.all([
    probeVersion("git"),
    probeVersion("codex"),
    probeVersion("opencode"),
  ]);

  return {
    nodeVersion: process.version,
    gitAvailable: git !== null,
    codexInstalled: codexVersion !== null,
    codexVersion,
    opencodeInstalled: opencodeVersion !== null,
    opencodeVersion,
    allowedRoots: ctx.config.allowedRoots,
    writeAllowed: ctx.config.allowWrite,
    activeTasks: ctx.concurrency.activeCount,
    maxConcurrency: ctx.concurrency.limit,
    platform: process.platform,
    executables: {
      codex: describeExecutable("codex"),
      opencode: describeExecutable("opencode"),
    },
  };
}
