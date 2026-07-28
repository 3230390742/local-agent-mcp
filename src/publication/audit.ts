import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { canonicalJson, sha256Text } from "./canonical.js";
import { sanitizePublicText } from "./sanitize.js";
import {
  PUBLIC_COMPARISON_NOTE,
  publicationReceiptSchema,
  publicDemoManifestSchema,
  type PublicationReceipt,
} from "./schema.js";

const FORBIDDEN_LABELS = [
  /\b(?:raw[-_\s]?stderr|stderr)\b/i,
  /\b(?:unreviewed\s+)?prompt(?:[._-]?(?:input|text|content|value|preview))?\b/i,
];
const CREDENTIAL_SHAPE = /(?:^|[^\p{L}\p{N}_])["']?(?:key|api[_-]?key|secret|password|passwd|token|provider|credentials?)["']?\s*[:=]\s*[^\s,}]+/iu;
const HTTP_URL = /\bhttps?:\/\/[^\s"'<>|]+/gi;

function labelsOutsideHttpUrls(value: string): string {
  return value.replace(HTTP_URL, "");
}

function isSchemaLockedComparisonNote(value: string, path: string[]): boolean {
  return path.length === 2 && path[0] === "comparison" && path[1] === "note" && value === PUBLIC_COMPARISON_NOTE;
}

function assertPublicStrings(value: unknown, path: string[] = []): void {
  if (typeof value === "string") {
    const isLockedNote = isSchemaLockedComparisonNote(value, path);
    let currentUsername = "";
    try { currentUsername = userInfo().username; } catch { /* unavailable */ }
    if (!isLockedNote && currentUsername && value.trim() === currentUsername) {
      throw new Error("public artifact contains forbidden data");
    }
    const sanitized = sanitizePublicText(value, "");
    if (!isLockedNote && sanitized !== value) {
      throw new Error("public artifact contains forbidden data");
    }
    if (
      CREDENTIAL_SHAPE.test(labelsOutsideHttpUrls(value)) ||
      FORBIDDEN_LABELS.some((pattern) => pattern.test(labelsOutsideHttpUrls(value)))
    ) {
      throw new Error("public artifact contains forbidden data");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicStrings(item, [...path, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertPublicStrings(item, [...path, key]);
    }
  }
}

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
  const stageIds = parsed.stages.map((stage) => stage.id);
  if (stageIds.join(",") !== "validate,authorize,execute,parse,redact,publish") {
    throw new Error("public scenario stages are not in the required order");
  }
  const text = canonicalJson(parsed);
  assertPublicStrings(parsed);
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
  const normalizedReceipt = { ...receipt, checks: [...receipt.checks].sort() };
  const normalizedExpected = { ...expected, checks: [...expected.checks].sort() };
  if (canonicalJson(normalizedReceipt) !== canonicalJson(normalizedExpected)) throw new Error("publication receipt mismatch");
  return receipt;
}
