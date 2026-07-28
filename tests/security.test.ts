import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, symlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAndAuthorizeCwd,
  assertWriteAllowed,
  isWithin,
  checkLength,
  SecurityError,
} from "../src/security.js";
import type { AppConfig } from "../src/config.js";

/**
 * Security tests: allowlist enforcement, ../ escape, symlink escape, write
 * gating, and input-length limits. These use real temp directories so that
 * fs.realpath behaves authentically (symlink resolution cannot be mocked
 * meaningfully).
 */

let tmpRoot: string;
let allowedDir: string;
let nestedDir: string;
let outsideDir: string;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    allowedRoots: [allowedDir],
    allowWrite: false,
    maxOutputBytes: 1_000_000,
    maxConcurrency: 3,
    debug: false,
    defaultTimeoutSeconds: 300,
    ...overrides,
  };
}

beforeAll(async () => {
  tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "lam-sec-")));
  allowedDir = path.join(tmpRoot, "allowed");
  nestedDir = path.join(allowedDir, "nested", "deep");
  outsideDir = path.join(tmpRoot, "outside");
  await mkdir(nestedDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("isWithin", () => {
  it("treats identical paths as within", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });
  it("treats nested paths as within", () => {
    expect(isWithin("/a/b", "/a/b/c/d")).toBe(true);
  });
  it("rejects sibling paths", () => {
    expect(isWithin("/a/b", "/a/bb")).toBe(false);
  });
  it("rejects parent traversal", () => {
    expect(isWithin("/a/b", "/a")).toBe(false);
  });
});

describe("resolveAndAuthorizeCwd - allowlist", () => {
  it("accepts a directory inside an allowed root", async () => {
    const { realCwd, matchedRoot } = await resolveAndAuthorizeCwd(
      nestedDir,
      makeConfig(),
    );
    expect(realCwd).toBe(await realpath(nestedDir));
    expect(matchedRoot).toBe(await realpath(allowedDir));
  });

  it("accepts the allowed root itself", async () => {
    const { realCwd } = await resolveAndAuthorizeCwd(allowedDir, makeConfig());
    expect(realCwd).toBe(await realpath(allowedDir));
  });

  it("rejects a directory outside all allowed roots", async () => {
    await expect(
      resolveAndAuthorizeCwd(outsideDir, makeConfig()),
    ).rejects.toMatchObject({ code: "cwd_outside_allowed" });
  });

  it("rejects when no roots are configured", async () => {
    await expect(
      resolveAndAuthorizeCwd(nestedDir, makeConfig({ allowedRoots: [] })),
    ).rejects.toMatchObject({ code: "no_allowed_roots" });
  });

  it("rejects relative paths", async () => {
    await expect(
      resolveAndAuthorizeCwd("relative/path", makeConfig()),
    ).rejects.toMatchObject({ code: "cwd_not_absolute" });
  });

  it("rejects empty cwd", async () => {
    await expect(
      resolveAndAuthorizeCwd("   ", makeConfig()),
    ).rejects.toMatchObject({ code: "invalid_cwd" });
  });

  it("rejects a non-existent directory", async () => {
    await expect(
      resolveAndAuthorizeCwd(path.join(allowedDir, "does-not-exist"), makeConfig()),
    ).rejects.toMatchObject({ code: "cwd_not_found" });
  });
});

describe("resolveAndAuthorizeCwd - ../ escape", () => {
  it("rejects paths that traverse out of the allowed root via ..", async () => {
    // allowedDir/../outside resolves (via realpath) to outsideDir, which is
    // outside the allowlist and must be rejected.
    const escapePath = path.join(allowedDir, "..", "outside");
    await expect(
      resolveAndAuthorizeCwd(escapePath, makeConfig()),
    ).rejects.toMatchObject({ code: "cwd_outside_allowed" });
  });

  it("normalizes .. that stays within the root", async () => {
    // allowedDir/nested/../nested/deep stays inside allowedDir.
    const inside = path.join(allowedDir, "nested", "..", "nested", "deep");
    const { realCwd } = await resolveAndAuthorizeCwd(inside, makeConfig());
    expect(realCwd).toBe(await realpath(nestedDir));
  });
});

describe("resolveAndAuthorizeCwd - symlink escape", () => {
  it("rejects a symlink inside the allowed root that points outside it", async () => {
    const linkPath = path.join(allowedDir, "escape-link");
    try {
      await symlink(outsideDir, linkPath, "dir");
    } catch (err) {
      // On Windows without privilege, dir symlinks may fail; skip in that case.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return;
      }
      throw err;
    }
    // The requested path is inside allowedDir, but realpath resolves it to
    // outsideDir, so it must be rejected as a symlink escape.
    await expect(
      resolveAndAuthorizeCwd(linkPath, makeConfig()),
    ).rejects.toMatchObject({ code: "cwd_outside_allowed" });
  });
});

describe("assertWriteAllowed", () => {
  it("throws when writes are disabled", () => {
    expect(() => assertWriteAllowed(makeConfig({ allowWrite: false }))).toThrow(
      SecurityError,
    );
  });
  it("passes when writes are enabled", () => {
    expect(() =>
      assertWriteAllowed(makeConfig({ allowWrite: true })),
    ).not.toThrow();
  });
});

describe("checkLength", () => {
  it("accepts values within the limit", () => {
    expect(() => checkLength("model", "gpt-5")).not.toThrow();
  });
  it("rejects oversized values", () => {
    expect(() => checkLength("model", "x".repeat(201))).toThrow(SecurityError);
  });
  it("ignores undefined", () => {
    expect(() => checkLength("model", undefined)).not.toThrow();
  });
});
