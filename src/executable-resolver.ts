import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Resolves a CLI name (codex/opencode) to a directly-spawnable target so that
 * child processes can always be launched with `shell: false`.
 *
 * Why this exists:
 *   On Windows, npm installs CLIs as `.cmd` shims. Since the Node.js fix for
 *   CVE-2024-27980, `spawn(<name>.cmd, args, { shell: false })` throws EINVAL.
 *   We refuse to set `shell: true` (that would reintroduce command-injection
 *   risk), so instead we resolve what the shim actually launches:
 *     - a native executable (e.g. opencode.exe) -> spawn it directly, or
 *     - `node <entry>.js` (e.g. codex) -> spawn node.exe with the entry script
 *       prepended to the argument array.
 *   Either way the user's prompt/args remain discrete array elements and no
 *   shell parsing ever occurs.
 *
 * On POSIX the bare name works directly and no resolution is needed.
 */
export interface ResolvedCommand {
  /** The executable to spawn (an absolute path, or a bare name on POSIX). */
  command: string;
  /** Arguments to prepend before the caller's arguments (e.g. a .js entry). */
  prefixArgs: string[];
}

/** In-process cache so we resolve each CLI at most once. */
const cache = new Map<string, ResolvedCommand | null>();

/**
 * Locates a bare command on PATH using the platform's own resolver. Returns the
 * absolute path or null. Uses `where` on Windows and `which`/`command -v`
 * elsewhere. spawnSync with shell:false is safe here (fixed argv).
 */
function whichSync(name: string): string[] {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(finder, [name], {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Extracts candidate target paths (.exe or .js, excluding node itself) from a
 * Windows `.cmd` shim, resolving the `%dp0%` / `%~dp0%` directory macro to the
 * shim's own directory.
 */
function parseCmdShim(shimPath: string): string[] {
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return [];
  }
  const dir = path.dirname(shimPath);
  const matches = [...content.matchAll(/"([^"]*\.(?:js|exe))"/gi)].map(
    (m) => m[1],
  );
  const resolved: string[] = [];
  for (const raw of matches) {
    const withDir = raw.replace(/%~?dp0%\\?/gi, dir + path.sep);
    const normalized = path.normalize(withDir);
    if (/[\\/]node\.exe$/i.test(normalized) || /^node\.exe$/i.test(normalized)) {
      continue;
    }
    resolved.push(normalized);
  }
  return resolved;
}

/**
 * Resolves `name` (a known CLI) to a spawnable command. On POSIX returns the
 * bare name. On Windows, finds the `.cmd`/`.exe` on PATH and, if it is a shim,
 * extracts the underlying native exe or `node <entry.js>` invocation.
 *
 * Returns null if the CLI cannot be found at all.
 */
export function resolveCommand(name: "codex" | "opencode"): ResolvedCommand | null {
  if (cache.has(name)) return cache.get(name)!;

  let result: ResolvedCommand | null = null;

  if (process.platform !== "win32") {
    // POSIX: bare name is directly spawnable.
    result = { command: name, prefixArgs: [] };
    cache.set(name, result);
    return result;
  }

  // Windows: enumerate PATH matches (where returns .exe and .cmd variants).
  const candidates = whichSync(name);

  // Prefer a real native .exe if PATH exposes one directly.
  const directExe = candidates.find((c) => /\.exe$/i.test(c) && existsSync(c));
  if (directExe) {
    result = { command: directExe, prefixArgs: [] };
    cache.set(name, result);
    return result;
  }

  // Otherwise inspect the .cmd shim to find what it launches.
  const shim = candidates.find((c) => /\.cmd$/i.test(c) && existsSync(c));
  if (shim) {
    const targets = parseCmdShim(shim);
    for (const target of targets) {
      if (!existsSync(target)) continue;
      if (/\.exe$/i.test(target)) {
        result = { command: target, prefixArgs: [] };
        break;
      }
      if (/\.js$/i.test(target)) {
        // Launch via the current Node runtime; args stay as an array.
        result = { command: process.execPath, prefixArgs: [target] };
        break;
      }
    }
  }

  cache.set(name, result);
  return result;
}

/** Clears the resolver cache. Intended for tests. */
export function clearResolverCache(): void {
  cache.clear();
}
