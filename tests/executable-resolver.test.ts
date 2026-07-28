import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { resolveCommand, clearResolverCache } from "../src/executable-resolver.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

/**
 * Executable resolver tests. The resolver's job is to always yield a
 * shell:false-spawnable target, which on Windows means bypassing `.cmd` shims
 * (blocked by the CVE-2024-27980 fix) in favour of a native `.exe` or
 * `node <entry.js>`.
 *
 * These tests are environment-sensitive (they inspect the real install), so
 * they assert structural invariants rather than exact paths.
 */

describe("resolveCommand", () => {
  it("caches results across calls", () => {
    clearResolverCache();
    const a = resolveCommand("codex");
    const b = resolveCommand("codex");
    expect(a).toBe(b); // same cached reference
  });

  it("never returns a .cmd shim as the command (Windows safety)", () => {
    for (const name of ["codex", "opencode"] as const) {
      const r = resolveCommand(name);
      if (r) {
        expect(r.command.toLowerCase().endsWith(".cmd")).toBe(false);
      }
    }
  });

  it("returns node + a .js entry, or a direct executable", () => {
    for (const name of ["codex", "opencode"] as const) {
      const r = resolveCommand(name);
      if (r && r.prefixArgs.length > 0) {
        // If prefixed, the prefix must be a .js entry launched by node.
        expect(r.prefixArgs[0].toLowerCase().endsWith(".js")).toBe(true);
        expect(r.command.toLowerCase()).toContain("node");
      }
      if (r) {
        // command is always a non-empty string.
        expect(typeof r.command).toBe("string");
        expect(r.command.length).toBeGreaterThan(0);
      }
    }
  });

  it("on Windows prefers a valid .cmd shim target over a direct .exe", () => {
    if (process.platform !== "win32") return;

    const directory = mkdtempSync(path.join(tmpdir(), "resolver-shim-"));
    const entry = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(directory, "codex.cmd");
    const fallback = path.join(directory, "codex.exe");

    try {
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "// test shim target\n");
      writeFileSync(shim, `@ECHO OFF\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n`);
      writeFileSync(fallback, "");
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 0,
        stdout: `${fallback}\n${shim}\n`,
      } as ReturnType<typeof spawnSync>);

      clearResolverCache();
      expect(resolveCommand("codex")).toEqual({
        command: process.execPath,
        prefixArgs: [entry],
      });
    } finally {
      clearResolverCache();
      vi.mocked(spawnSync).mockClear();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("on Windows resolves a PATH codex.cmd to its spawnable target when available", () => {
    if (process.platform !== "win32") return;

    const found = spawnSync("where", ["codex"], {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
    });
    const shim = found.stdout
      ?.split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find((candidate) => /codex\.cmd$/i.test(candidate) && existsSync(candidate));
    if (!shim) return;

    clearResolverCache();
    const resolved = resolveCommand("codex");

    expect(resolved).not.toBeNull();
    expect(resolved?.command).not.toMatch(/WindowsApps/i);
    expect(
      resolved?.command === process.execPath && resolved.prefixArgs[0]?.toLowerCase().endsWith(".js"),
    ).toBe(true);
  });

  it("on POSIX returns the bare name with no prefix args", () => {
    if (process.platform === "win32") return; // skip on Windows
    clearResolverCache();
    const r = resolveCommand("codex");
    expect(r).toEqual({ command: "codex", prefixArgs: [] });
  });
});
