import { describe, it, expect } from "vitest";
import { runProcess } from "../src/process-runner.js";

/**
 * Process runner tests. These spawn the current Node binary with small inline
 * scripts so the tests are fully cross-platform and self-contained (no reliance
 * on codex/opencode being installed or logged in).
 */

const NODE = process.execPath;

describe("runProcess - basic execution", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('hello')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("reports non-zero exit codes", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    expect(r.exitCode).toBe(7);
  });

  it("rejects when the executable does not exist", async () => {
    await expect(
      runProcess({
        command: "definitely-not-a-real-binary-xyz",
        args: [],
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("runProcess - timeout", () => {
  it("kills a long-running process and sets timedOut", async () => {
    const start = Date.now();
    const r = await runProcess({
      command: NODE,
      // Sleep for 60s; the timeout must terminate it well before then.
      args: ["-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      timeoutMs: 500,
      maxOutputBytes: 1_000_000,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(15_000);
    // Killed by signal => exitCode null (or non-zero on Windows).
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    // Ignore SIGTERM so only SIGKILL (after the 5s grace) can stop it.
    const script =
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const start = Date.now();
    const r = await runProcess({
      command: NODE,
      args: ["-e", script],
      cwd: process.cwd(),
      timeoutMs: 300,
      maxOutputBytes: 1_000_000,
    });
    expect(r.timedOut).toBe(true);
    // Must have taken at least the ~5s grace period before SIGKILL landed.
    // (On POSIX; on Windows SIGTERM cannot be trapped so it may end sooner.)
    if (process.platform !== "win32") {
      expect(Date.now() - start).toBeGreaterThanOrEqual(4_500);
    }
  }, 20_000);
});

describe("runProcess - output cap", () => {
  it("truncates output that exceeds maxOutputBytes", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 1_000,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1_000);
  });
});

describe("runProcess - command injection safety (shell:false)", () => {
  it("passes shell metacharacters as literal arguments, not commands", async () => {
    // If a shell were involved, "&&" / ";" / "$(...)" would execute. With
    // shell:false the whole string is a single literal argv entry that Node
    // simply prints back.
    const payload = "hi; echo PWNED && whoami $(id) `uname`";
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.stdout.write(process.argv[1])", payload],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    // The payload is echoed verbatim; no injected command output appears.
    expect(r.stdout).toBe(payload);
    expect(r.stdout).not.toContain("PWNED\n");
    expect(r.exitCode).toBe(0);
  });
});
