import { spawn } from "node:child_process";
import { log } from "./logger.js";

export interface RunOptions {
  /** Executable to run. Must be a fixed, known binary name — never user input. */
  command: string;
  /** Arguments passed as a discrete array (never shell-concatenated). */
  args: string[];
  /** Working directory for the child process. */
  cwd: string;
  /** Timeout in milliseconds before SIGTERM is sent. */
  timeoutMs: number;
  /** Max bytes of stdout+stderr to buffer before truncating. */
  maxOutputBytes: number;
  /** Extra environment variables merged onto the inherited environment. */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  /** Process exit code, or null if killed by a signal. */
  exitCode: number | null;
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  /** Captured stdout (possibly truncated). */
  stdout: string;
  /** Captured stderr (possibly truncated). */
  stderr: string;
  /** True if the process was killed due to timeout. */
  timedOut: boolean;
  /** True if stdout or stderr was truncated due to the byte cap. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * Spawns a child process with strict safety guarantees:
 *
 *  - `shell: false` always. Arguments are passed as an array so no shell
 *    interpolation or command injection is possible.
 *  - stdin is closed immediately (agents run non-interactively).
 *  - Output is capped at `maxOutputBytes` across stdout+stderr combined; once
 *    exceeded, further data is dropped and `truncated` is set.
 *  - On timeout, SIGTERM is sent first; if the process is still alive after
 *    KILL_GRACE_MS, SIGKILL is sent.
 *
 * This function never rejects for process-level failures (non-zero exit,
 * signals, timeouts) — those are reported in the RunResult. It only rejects if
 * the process could not be spawned at all (e.g. ENOENT).
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const { command, args, cwd, timeoutMs, maxOutputBytes, env } = options;
  const start = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      shell: false, // CRITICAL: never use a shell.
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const appendCapped = (chunk: Buffer, target: "out" | "err") => {
      if (truncated) return;
      const remaining = maxOutputBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      let piece: Buffer = chunk;
      if (chunk.length > remaining) {
        piece = chunk.subarray(0, remaining);
        truncated = true;
      }
      bytes += piece.length;
      const text = piece.toString("utf8");
      if (target === "out") stdout += text;
      else stderr += text;
    };

    child.stdout.on("data", (c: Buffer) => appendCapped(c, "out"));
    child.stderr.on("data", (c: Buffer) => appendCapped(c, "err"));

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log("warn", `Process timed out after ${timeoutMs}ms; sending SIGTERM`, {
        command,
      });
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        log("warn", "Process did not exit after SIGTERM; sending SIGKILL", {
          command,
        });
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - start,
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code, signal) => finish(code, signal));
  });
}
