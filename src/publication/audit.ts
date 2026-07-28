import { readFile } from "node:fs/promises";
import { canonicalJson, sha256Text } from "./canonical.js";
import { publicationReceiptSchema, publicDemoManifestSchema, type PublicationReceipt } from "./schema.js";

const FORBIDDEN = [
  /[A-Za-z]:\\/,
  /(^|[\s"'])\/(?!\/)(?:[^\s"']+)/,
  /\\\\[^\s"']+/,
  /\bses_[A-Za-z0-9_-]+\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:authorization|proxy-authorization)\s*:\s*\S+/i,
  /\b(?:raw[-_\s]?stderr|stderr)\s*:/i,
  /\bunreviewed\s+prompt\s*:/i,
];

export function auditManifest(input: unknown): PublicationReceipt {
  const parsed = publicDemoManifestSchema.parse(input);
  if (
    parsed.policy.allowedRoot !== "fixtures/public-demo" ||
    parsed.policy.writeAllowed ||
    parsed.policy.shell ||
    parsed.policy.maxConcurrency !== 2 ||
    parsed.policy.maxOutputBytes !== 1_000_000
  ) {
    throw new Error("public scenario policy is not fixed read-only");
  }
  if (
    parsed.stages.some((stage) => stage.status !== "passed") ||
    parsed.comparison.codex.status !== "passed" ||
    parsed.comparison.opencode.status !== "passed"
  ) {
    throw new Error("public scenario did not fully pass");
  }
  const text = canonicalJson(parsed);
  const matched = FORBIDDEN.find((pattern) => pattern.test(text));
  if (matched) throw new Error(`public artifact contains forbidden data: ${matched.source}`);
  return publicationReceiptSchema.parse({
    schemaVersion: 1,
    status: "PUBLICATION_OK",
    manifestSha256: sha256Text(text),
    checks: ["schema", "read_only", "no_absolute_paths", "no_credentials", "no_session_ids", "verification", "source_revision"],
  });
}

export async function auditPublishedDemo(manifestPath: string, receiptPath: string): Promise<PublicationReceipt> {
  const manifest = publicDemoManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const receipt = publicationReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  const expected = auditManifest(manifest);
  if (receipt.manifestSha256 !== expected.manifestSha256) throw new Error("manifest hash mismatch");
  if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("publication receipt mismatch");
  return receipt;
}
