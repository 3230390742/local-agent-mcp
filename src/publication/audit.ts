import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { canonicalJson, sha256Text } from "./canonical.js";
import { sanitizePublicText } from "./sanitize.js";
import { publicationReceiptSchema, publicDemoManifestSchema, type PublicationReceipt } from "./schema.js";

const FORBIDDEN_LABELS = [
  /\b(?:raw[-_\s]?stderr|stderr)\b/i,
  /\b(?:unreviewed\s+)?prompt(?:[._-]?(?:input|text|content|value|preview))?\b/i,
];
const CREDENTIAL_SHAPE = /(?:^|[^\p{L}\p{N}_])(?:key|api[_-]?key|secret|password|passwd|token|provider)\s*[:=]\s*[^\s,}]+/iu;

function shortUsernameRedactionOnly(value: string, sanitized: string): boolean {
  const usernames = new Set<string>();
  try { usernames.add(userInfo().username); } catch { /* unavailable */ }
  if (process.env.USERNAME) usernames.add(process.env.USERNAME);
  if (process.env.USER) usernames.add(process.env.USER);
  let expected = value;
  for (const username of usernames) {
    if (username.length !== 1) continue;
    expected = expected.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${username}(?![\\p{L}\\p{N}_])`, "giu"), "$1<local-username>");
  }
  return expected === sanitized;
}

function assertPublicStrings(value: unknown, path: string[] = []): void {
  if (typeof value === "string") {
    let currentUsername = "";
    try { currentUsername = userInfo().username; } catch { /* unavailable */ }
    if (currentUsername && value.trim() === currentUsername) {
      throw new Error("public artifact contains forbidden data");
    }
    const sanitized = sanitizePublicText(value, "");
    if (sanitized !== value && !shortUsernameRedactionOnly(value, sanitized)) {
      throw new Error("public artifact contains forbidden data");
    }
    if (
      CREDENTIAL_SHAPE.test(value) ||
      FORBIDDEN_LABELS.some((pattern) => pattern.test(value))
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
  if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("publication receipt mismatch");
  return receipt;
}
