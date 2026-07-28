#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../process-runner.js";
import { runAgentHealth } from "../tools/agent-health.js";
import { runAgentCompare } from "../tools/agent-compare.js";
import { auditManifest } from "../publication/audit.js";
import { writeCanonicalJson } from "../publication/canonical.js";
import { recordPublicDemo } from "../publication/recorder.js";
import { readVitestSummary } from "../publication/verification.js";
import { formatRecordFailure } from "./errors.js";

async function main(): Promise<void> {
  const root = process.cwd();
  const flag = process.argv.indexOf("--verification");
  if (flag < 0 || !process.argv[flag + 1]) throw new Error("--verification is required");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const revision = async () => {
    const result = await runProcess({ command: "git", args: ["rev-parse", "HEAD"], cwd: root, timeoutMs: 10_000, maxOutputBytes: 1_000 });
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(value)) throw new Error("source revision unavailable");
    return value;
  };
  const manifest = await recordPublicDemo({
    fixtureRoot: path.join(root, "fixtures", "public-demo"), projectVersion: packageJson.version,
    verification: await readVitestSummary(path.resolve(root, process.argv[flag + 1])),
    dependencies: { now: () => new Date(), revision, health: runAgentHealth, compare: runAgentCompare },
  });
  const receipt = auditManifest(manifest);
  await writeCanonicalJson(path.join(root, "public-demo", "demo-manifest.json"), manifest);
  await writeCanonicalJson(path.join(root, "public-demo", "publication-receipt.json"), receipt);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, manifest: "public-demo/demo-manifest.json", receipt: "public-demo/publication-receipt.json" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${formatRecordFailure(error)}\n`);
  process.exitCode = 1;
});
