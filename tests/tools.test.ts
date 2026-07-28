import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConcurrencyManager } from "../src/concurrency.js";
import type { AppConfig } from "../src/config.js";
import type { ToolContext } from "../src/context.js";
import { runCodex } from "../src/tools/codex-run.js";
import { runOpenCode } from "../src/tools/opencode-run.js";

/**
 * Tool-level tests that exercise security gating and the per-directory write
 * lock WITHOUT depending on codex/opencode being installed or logged in.
 *
 * Strategy: point the allowlist at a real temp dir but drive error paths that
 * resolve BEFORE any process spawn (write-not-allowed, cwd-outside-allowed,
 * write-lock-conflict). These return structured errors, never throw.
 */

let tmpRoot: string;
let allowedDir: string;

function ctx(overrides: Partial<AppConfig> = {}): ToolContext {
  const config: AppConfig = {
    allowedRoots: [allowedDir],
    allowWrite: false,
    maxOutputBytes: 1_000_000,
    maxConcurrency: 3,
    debug: false,
    defaultTimeoutSeconds: 300,
    ...overrides,
  };
  return { config, concurrency: new ConcurrencyManager(config.maxConcurrency) };
}

beforeAll(async () => {
  tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "lam-tool-")));
  allowedDir = tmpRoot;
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("codex_run - security gating", () => {
  it("returns write_not_allowed for workspace_write when writes are disabled", async () => {
    const r = await runCodex(
      { prompt: "x", cwd: allowedDir, mode: "workspace_write", output_mode: "final" },
      ctx({ allowWrite: false }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("write_not_allowed");
  });

  it("returns cwd_outside_allowed for a directory outside the allowlist", async () => {
    const outside = await realpath(os.tmpdir());
    const r = await runCodex(
      { prompt: "x", cwd: outside, mode: "read_only", output_mode: "final" },
      ctx({ allowedRoots: [path.join(allowedDir, "sub-not-exist-root")] }),
    );
    expect(r.ok).toBe(false);
    // Either outside-allowed or not-found depending on realpath resolution.
    expect(["cwd_outside_allowed", "cwd_not_found", "no_allowed_roots"]).toContain(
      r.error?.code,
    );
  });

  it("returns cwd_not_absolute for a relative path", async () => {
    const r = await runCodex(
      { prompt: "x", cwd: "relative/dir", mode: "read_only", output_mode: "final" },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("cwd_not_absolute");
  });
});

describe("opencode_run - security gating", () => {
  it("returns write_not_allowed when auto_approve is set but writes disabled", async () => {
    const r = await runOpenCode(
      { prompt: "x", cwd: allowedDir, auto_approve: true, output_mode: "final" },
      ctx({ allowWrite: false }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("write_not_allowed");
  });
});

describe("same-directory write lock via tools", () => {
  it("second concurrent write task to same dir gets write_lock_conflict", async () => {
    // Hold the write lock directly, then attempt a write-mode tool call.
    const context = ctx({ allowWrite: true });
    const release = await context.concurrency.acquire(allowedDir);
    try {
      const r = await runCodex(
        {
          prompt: "x",
          cwd: allowedDir,
          mode: "workspace_write",
          output_mode: "final",
        },
        context,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("write_lock_conflict");
    } finally {
      release();
    }
  });
});
