import { describe, expect, it } from "vitest";
import type { AgentCompareResult } from "../../src/tools/agent-compare.js";
import { recordPublicDemo, type RecorderDependencies } from "../../src/publication/recorder.js";

function fakeSuccessfulComparison(): AgentCompareResult {
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
        ok: true, agent: "codex", mode: "read_only", cwd: "D:\\Users\\alice\\demo",
        finalMessage: "Review complete for D:\\Users\\alice\\demo.", threadId: "thread_private",
        commands: [{ command: "type secret.env", exitCode: 0 }], fileChanges: [], errors: [],
        exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 120,
        events: [{ private: true }],
      },
    },
    opencode: {
      ok: true,
      durationMs: 140,
      exitStatus: { exitCode: 0, signal: null, timedOut: false },
      result: {
        ok: true, agent: "opencode", cwd: "D:\\Users\\alice\\demo", autoApprove: false,
        finalMessage: "Review complete for D:\\Users\\alice\\demo.", sessionId: "ses_private",
        tools: [{ tool: "read", target: "D:\\Users\\alice\\demo\\src\\a.ts" }], fileChanges: [], errors: [],
        exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 140,
        events: [{ private: true }],
      },
    },
  };
}

const dependencies: RecorderDependencies = {
  now: () => new Date("2026-07-28T00:00:00.000Z"),
  revision: async () => "a".repeat(40),
  health: async (ctx) => ({
    nodeVersion: "v24.15.0", gitAvailable: true, codexInstalled: true, codexVersion: "codex 1",
    opencodeInstalled: true, opencodeVersion: "opencode 1", allowedRoots: ctx.config.allowedRoots,
    writeAllowed: false, activeTasks: 0, maxConcurrency: 2, platform: "win32",
    executables: { codex: "private", opencode: "private" },
  }),
  compare: async () => fakeSuccessfulComparison(),
};

describe("recordPublicDemo", () => {
  it("records one fixed read-only scenario with only public projection", async () => {
    const manifest = await recordPublicDemo({
      fixtureRoot: "D:\\Users\\alice\\demo",
      projectVersion: "1.0.0",
      verification: { testFilesPassed: 14, testFilesTotal: 14, testsPassed: 90, testsTotal: 90, typecheck: "passed" },
      dependencies,
    });
    expect(manifest.scenario.id).toBe("api-input-validation-review");
    expect(manifest.scenario.prompt).toBe("Review the input validation in this small API fixture. Identify concrete edge cases and recommend bounded validation. Do not modify files.");
    expect(manifest.policy).toMatchObject({ writeAllowed: false, shell: false, maxConcurrency: 2 });
    expect(manifest.stages.map((stage) => stage.id)).toEqual(["validate", "authorize", "execute", "parse", "redact", "publish"]);
    expect(manifest.verification.testsPassed).toBe(90);
    expect(JSON.stringify(manifest)).not.toMatch(/D:\\\\Users|ses_|threadId|sessionId|events/);
  });

  it("rejects when either agent fails", async () => {
    const failing = { ...dependencies, compare: async () => {
      const value = fakeSuccessfulComparison();
      value.codex = { ...value.codex, ok: false };
      return value;
    } };
    await expect(recordPublicDemo({
      fixtureRoot: "D:\\Users\\alice\\demo", projectVersion: "1.0.0",
      verification: { testFilesPassed: 1, testFilesTotal: 1, testsPassed: 1, testsTotal: 1, typecheck: "passed" },
      dependencies: failing,
    })).rejects.toThrow("public scenario did not fully pass");
  });

  it.each([
    ["allowed roots", { allowedRoots: ["D:\\other"] }],
    ["write mode", { writeAllowed: true }],
    ["concurrency", { maxConcurrency: 3 }],
  ])("rejects a health snapshot with mismatched %s", async (_name, change) => {
    const mutated = { ...dependencies, health: async (ctx: Parameters<RecorderDependencies["health"]>[0]) => ({
      ...await dependencies.health(ctx), ...change,
    }) };
    await expect(recordPublicDemo({
      fixtureRoot: "D:\\Users\\alice\\demo", projectVersion: "1.0.0",
      verification: { testFilesPassed: 1, testFilesTotal: 1, testsPassed: 1, testsTotal: 1, typecheck: "passed" },
      dependencies: mutated,
    })).rejects.toThrow("public scenario health policy mismatch");
  });
});
