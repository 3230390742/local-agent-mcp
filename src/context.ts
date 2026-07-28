import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { ConcurrencyManager } from "./concurrency.js";
import { resolveCommand } from "./executable-resolver.js";

/**
 * Shared runtime context passed to every tool handler. Holds validated config
 * and the singleton concurrency manager so tools do not reach for globals.
 */
export interface ToolContext {
  config: AppConfig;
  concurrency: ConcurrencyManager;
}

/**
 * Fixed, known executable names. User input is NEVER used to choose an
 * executable — only these constants are ever spawned.
 */
export const EXECUTABLES = {
  codex: "codex",
  opencode: "opencode",
  git: "git",
  node: "node",
} as const;

export type KnownExecutable = keyof typeof EXECUTABLES;

/**
 * Returns a human-readable label for how a CLI will be invoked (for health
 * reporting). Falls back to the bare name when resolution fails.
 */
export function describeExecutable(name: "codex" | "opencode"): string {
  const resolved = resolveCommand(name);
  if (!resolved) return `${name} (not found)`;
  return resolved.prefixArgs.length > 0
    ? `${resolved.command} ${resolved.prefixArgs.join(" ")}`
    : resolved.command;
}

/**
 * Runs a known CLI with `--version` and returns the trimmed stdout, or null if
 * the tool is not installed / not resolvable. Used by agent_health.
 *
 * For codex/opencode this uses the resolver so it works with `.cmd` shims on
 * Windows (shell:false). For git/node it spawns the bare name (real exes).
 * Never throws.
 */
export function probeVersion(name: KnownExecutable): Promise<string | null> {
  let command: string;
  let args: string[];

  if (name === "codex" || name === "opencode") {
    const resolved = resolveCommand(name);
    if (!resolved) return Promise.resolve(null);
    command = resolved.command;
    args = [...resolved.prefixArgs, "--version"];
  } else {
    command = EXECUTABLES[name];
    args = ["--version"];
  }

  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 10_000);
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 && out.trim() ? out.trim() : out.trim() || null);
      });
    } catch {
      finish(null);
    }
  });
}
