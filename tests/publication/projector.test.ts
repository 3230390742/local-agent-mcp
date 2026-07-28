import { describe, expect, it } from "vitest";
import type { AgentCompareResult } from "../../src/tools/agent-compare.js";
import { projectComparison } from "../../src/publication/projector.js";

function privateComparison(): AgentCompareResult {
  return {
    prompt_preview: "private prompt",
    cwd: "D:\\Users\\alice\\demo",
    parallel: true,
    note: "private note",
    codex: {
      ok: true,
      durationMs: 120,
      exitStatus: { exitCode: 0, signal: null, timedOut: false },
      result: {
        ok: true,
        agent: "codex",
        mode: "read_only",
        cwd: "D:\\Users\\alice\\demo",
        finalMessage: "See D:\\Users\\alice\\demo\\src\\a.ts",
        threadId: "019f2918-9644-7480-867c-c993bf84dfd7",
        commands: [{ command: "type secret.env", exitCode: 0 }],
        fileChanges: [],
        errors: [],
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 120,
        events: [{ token: "private" }],
      },
    },
    opencode: {
      ok: true,
      durationMs: 140,
      exitStatus: { exitCode: 0, signal: null, timedOut: false },
      result: {
        ok: true,
        agent: "opencode",
        cwd: "D:\\Users\\alice\\demo",
        autoApprove: false,
        finalMessage: "session ses_private done",
        sessionId: "ses_private",
        tools: [{ tool: "read", target: "D:\\Users\\alice\\demo\\src\\a.ts" }],
        fileChanges: [],
        errors: [],
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 140,
        events: [{ authorization: "Bearer private" }],
      },
    },
  };
}

describe("projectComparison", () => {
  it("selects only approved public fields", () => {
    const output = projectComparison(
      privateComparison(),
      "D:\\Users\\alice\\demo",
    );
    const json = JSON.stringify(output);
    expect(output.codex.activity).toEqual({ commands: 1, files: 0 });
    expect(output.opencode.activity).toEqual({ commands: 1, files: 0 });
    expect(json).not.toMatch(
      /D:\\\\Users|threadId|sessionId|events|type secret\.env|ses_private|Bearer private/,
    );
    expect(output.note).toContain("without ranking");
  });

  it("replaces every execution error with a fixed public summary", () => {
    const comparison = privateComparison();
    comparison.codex = {
      ...comparison.codex,
      ok: false,
      result: {
        ...comparison.codex.result!,
        errors: [
          "stderr: sk-proj-ABCDEFGHIJKLMNOP1234567890 D:\\Users\\alice\\demo ses_private 019f2918-9644-7480-867c-c993bf84dfd7",
        ],
      },
      error: {
        code: "execution_failed",
        message:
          "stderr: Authorization: Bearer secret-token /etc/hosts alice ses_private",
      },
    };
    comparison.opencode = {
      ...comparison.opencode,
      ok: false,
      result: null,
      error: {
        code: "execution_failed",
        message:
          "stderr: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \\\\server\\share\\a.txt bob ses_private",
      },
    };

    const output = projectComparison(comparison, "D:\\Users\\alice\\demo");
    const json = JSON.stringify(output);

    expect(output.codex.errors).toEqual([
      "Agent execution details are unavailable.",
    ]);
    expect(output.opencode.errors).toEqual([
      "Agent execution details are unavailable.",
    ]);
    expect(json).not.toMatch(
      /stderr:|sk-proj-|Authorization:|secret-token|D:\\\\Users|\/etc\/hosts|alice|bob|ses_private|019f2918|ghp_|server\\\\share/,
    );
  });
});
