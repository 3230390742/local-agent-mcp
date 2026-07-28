import { describe, it, expect } from "vitest";
import { resolveCommand, clearResolverCache } from "../src/executable-resolver.js";

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

  it("on POSIX returns the bare name with no prefix args", () => {
    if (process.platform === "win32") return; // skip on Windows
    clearResolverCache();
    const r = resolveCommand("codex");
    expect(r).toEqual({ command: "codex", prefixArgs: [] });
  });
});
