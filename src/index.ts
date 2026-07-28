#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { setLogLevel, log } from "./logger.js";
import { ConcurrencyManager } from "./concurrency.js";
import { SecurityError } from "./security.js";
import type { ToolContext } from "./context.js";

import { runAgentHealth } from "./tools/agent-health.js";
import { runCodex } from "./tools/codex-run.js";
import { runOpenCode } from "./tools/opencode-run.js";
import { runAgentCompare } from "./tools/agent-compare.js";

/**
 * Entry point. Wires configuration, the concurrency manager, and the four MCP
 * tools onto an McpServer, then serves over stdio.
 *
 * Invariants:
 *  - Nothing is ever written to stdout except MCP protocol traffic. All logs go
 *    to stderr via the logger module.
 *  - Tool handlers return JSON-encoded text content. Errors are converted to
 *    structured payloads with isError=true rather than thrown, so the client
 *    always receives a well-formed response.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.debug) setLogLevel("debug");

  const concurrency = new ConcurrencyManager(config.maxConcurrency);
  const ctx: ToolContext = { config, concurrency };

  const server = new McpServer({
    name: "local-agent-mcp",
    version: "1.0.0",
  });

  /** Wraps a tool result object into MCP text content. */
  const ok = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });

  /** Wraps an error into an MCP error result with a structured body. */
  const fail = (code: string, message: string) => ({
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: { code, message } }, null, 2),
      },
    ],
  });

  /** Normalizes thrown errors (esp. SecurityError) into a fail() response. */
  const toFail = (err: unknown) => {
    if (err instanceof SecurityError) return fail(err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Tool handler threw", { message });
    return fail("internal_error", message);
  };

  // --- agent_health -------------------------------------------------------
  server.registerTool(
    "agent_health",
    {
      title: "Agent Health Check",
      description:
        "Report the local agent environment: Node version, Git availability, " +
        "Codex/OpenCode install status and versions, allowed working directories, " +
        "whether writes are permitted, and current concurrency usage.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await runAgentHealth(ctx));
      } catch (err) {
        return toFail(err);
      }
    },
  );

  // --- codex_run ----------------------------------------------------------
  server.registerTool(
    "codex_run",
    {
      title: "Run Codex CLI",
      description:
        "Run the locally installed, logged-in Codex CLI non-interactively in a " +
        "sandboxed working directory. Defaults to read-only. Use workspace_write " +
        "only when writes are enabled server-side. Returns the final agent " +
        "message plus command/file-change/error summaries.",
      inputSchema: {
        prompt: z.string().min(1).max(100_000).describe("Instructions for Codex."),
        cwd: z
          .string()
          .min(1)
          .max(4_096)
          .describe("Absolute path to an allowed working directory."),
        mode: z
          .enum(["read_only", "workspace_write"])
          .default("read_only")
          .describe("read_only (default) or workspace_write."),
        model: z.string().max(200).optional().describe("Optional model override."),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(3_600)
          .optional()
          .describe("Timeout in seconds (10-3600)."),
        output_mode: z
          .enum(["final", "events"])
          .default("final")
          .describe("final summary or full raw events."),
      },
    },
    async (args) => {
      try {
        return ok(await runCodex(args, ctx));
      } catch (err) {
        return toFail(err);
      }
    },
  );

  // --- opencode_run -------------------------------------------------------
  server.registerTool(
    "opencode_run",
    {
      title: "Run OpenCode CLI",
      description:
        "Run the locally installed, logged-in OpenCode CLI non-interactively in a " +
        "sandboxed working directory. auto_approve enables side-effecting actions " +
        "and requires server-side write permission. Supports session continuation " +
        "and agent/model selection.",
      inputSchema: {
        prompt: z.string().min(1).max(100_000).describe("Instructions for OpenCode."),
        cwd: z
          .string()
          .min(1)
          .max(4_096)
          .describe("Absolute path to an allowed working directory."),
        model: z.string().max(200).optional().describe("provider/model override."),
        agent: z.string().max(200).optional().describe("Named OpenCode agent."),
        session_id: z
          .string()
          .max(200)
          .optional()
          .describe("Existing session id (ses_...) to continue."),
        auto_approve: z
          .boolean()
          .default(false)
          .describe("Auto-approve actions (write). Requires AGENT_ALLOW_WRITE."),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(3_600)
          .optional()
          .describe("Timeout in seconds (10-3600)."),
        output_mode: z
          .enum(["final", "events"])
          .default("final")
          .describe("final summary or full raw events."),
      },
    },
    async (args) => {
      try {
        return ok(await runOpenCode(args, ctx));
      } catch (err) {
        return toFail(err);
      }
    },
  );

  // --- agent_compare ------------------------------------------------------
  server.registerTool(
    "agent_compare",
    {
      title: "Compare Codex and OpenCode",
      description:
        "Run Codex and OpenCode against the same prompt in READ-ONLY mode and " +
        "return both results verbatim. Does not judge which is better; the caller " +
        "synthesizes the conclusion. One agent failing does not suppress the other.",
      inputSchema: {
        prompt: z.string().min(1).max(100_000).describe("Prompt for both agents."),
        cwd: z
          .string()
          .min(1)
          .max(4_096)
          .describe("Absolute path to an allowed working directory."),
        codex_model: z.string().max(200).optional().describe("Codex model override."),
        opencode_model: z
          .string()
          .max(200)
          .optional()
          .describe("OpenCode model override."),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(3_600)
          .optional()
          .describe("Per-agent timeout in seconds (10-3600)."),
        parallel: z
          .boolean()
          .default(true)
          .describe("Run both agents in parallel (default) or sequentially."),
      },
    },
    async (args) => {
      try {
        return ok(await runAgentCompare(args, ctx));
      } catch (err) {
        return toFail(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", "local-agent-mcp started", {
    allowedRoots: String(config.allowedRoots.length),
    writeAllowed: String(config.allowWrite),
    maxConcurrency: String(config.maxConcurrency),
  });
}

main().catch((err) => {
  log("error", "Fatal startup error", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
