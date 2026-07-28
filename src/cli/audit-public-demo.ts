#!/usr/bin/env node
import path from "node:path";
import { auditPublishedDemo } from "../publication/audit.js";
import { formatAuditFailure } from "./errors.js";

async function main(): Promise<void> {
  const root = process.cwd();
  const receipt = await auditPublishedDemo(path.join(root, "public-demo", "demo-manifest.json"), path.join(root, "public-demo", "publication-receipt.json"));
  process.stdout.write(`${JSON.stringify({ status: receipt.status, manifestSha256: receipt.manifestSha256 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${formatAuditFailure(error)}\n`);
  process.exitCode = 1;
});
