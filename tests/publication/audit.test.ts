import { describe, expect, it } from "vitest";
import { auditManifest, auditPublishedDemo } from "../../src/publication/audit.js";
import { canonicalJson, writeCanonicalJson } from "../../src/publication/canonical.js";
import { publicationReceiptSchema } from "../../src/publication/schema.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface MutationTarget {
  policy: { writeAllowed: boolean };
  comparison: { codex: { finalMessage: string | null } };
  verification: { testsPassed: number };
  sourceRevision: string;
}

function validManifest(): Record<string, unknown> & MutationTarget {
  const run = (agent: "codex" | "opencode") => ({ agent, status: "passed", durationMs: 120, finalMessage: "Review complete.", activity: { commands: 0, files: 0 }, errors: [] });
  return {
    schemaVersion: 1, generatedAt: "2026-07-28T00:00:00.000Z", sourceRevision: "a".repeat(40),
    project: { name: "local-agent-mcp", version: "1.0.0", repositoryUrl: "https://github.com/3230390742/local-agent-mcp" },
    scenario: { id: "api-input-validation-review", title: "API 输入校验审查", prompt: "Review the public API fixture without modifying files.", workspaceLabel: "fixtures/public-demo", mode: "read_only" },
    policy: { allowedRoot: "fixtures/public-demo", writeAllowed: false, shell: false, maxConcurrency: 2, maxOutputBytes: 1_000_000 },
    environment: { node: "v24.15.0", codexAvailable: true, opencodeAvailable: true },
    stages: ["validate", "authorize", "execute", "parse", "redact", "publish"].map((id) => ({ id, status: "passed", detail: `${id} passed` })),
    comparison: { note: "Results are shown without ranking; model output is not a benchmark.", codex: run("codex"), opencode: run("opencode") },
    verification: { testFilesPassed: 14, testFilesTotal: 14, testsPassed: 90, testsTotal: 90, typecheck: "passed" },
  };
}

describe("auditManifest", () => {
  it.each([
    ["write enabled", (value: MutationTarget) => { value.policy.writeAllowed = true; }],
    ["Windows path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "D:\\Users\\alice\\secret.txt"; }],
    ["POSIX path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "/etc/hosts"; }],
    ["UNC path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "\\\\server\\share\\secret.txt"; }],
    ["session id", (value: MutationTarget) => { value.comparison.codex.finalMessage = "ses_private"; }],
    ["thread id", (value: MutationTarget) => { value.comparison.codex.finalMessage = "019f2918-9644-7480-867c-c993bf84dfd7"; }],
    ["token", (value: MutationTarget) => { value.comparison.codex.finalMessage = "sk-proj-ABCDEFGHIJKLMNOP1234567890"; }],
    ["generic authorization header", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Authorization: Basic abc"; }],
    ["proxy authorization header", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Proxy-Authorization: Bearer abc"; }],
    ["raw stderr label", (value: MutationTarget) => { value.comparison.codex.finalMessage = "raw stderr: secret"; }],
    ["unreviewed prompt label", (value: MutationTarget) => { value.comparison.codex.finalMessage = "unreviewed prompt: do this"; }],
    ["failed tests", (value: MutationTarget) => { value.verification.testsPassed -= 1; }],
    ["bad revision", (value: MutationTarget) => { value.sourceRevision = "abc"; }],
  ])("rejects %s", (_name, mutate) => {
    const value = validManifest();
    mutate(value);
    expect(() => auditManifest(value)).toThrow();
  });

  it("preserves legitimate HTTP repository URLs", () => expect(() => auditManifest(validManifest())).not.toThrow());

  it("rejects a changed manifest through the receipt hash", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "public-demo-"));
    const manifestPath = path.join(dir, "manifest.json");
    const receiptPath = path.join(dir, "receipt.json");
    const manifest = validManifest();
    const receipt = auditManifest(manifest);
    await writeCanonicalJson(manifestPath, manifest);
    await writeCanonicalJson(receiptPath, receipt);
    manifest.comparison.codex.finalMessage = "changed";
    await writeFile(manifestPath, canonicalJson(manifest), "utf8");
    await expect(auditPublishedDemo(manifestPath, receiptPath)).rejects.toThrow("manifest hash mismatch");
    expect(await readFile(receiptPath, "utf8")).toContain("PUBLICATION_OK");
  });

  it("requires the complete receipt contract", () => {
    expect(() => publicationReceiptSchema.parse({ ...auditManifest(validManifest()), checks: ["schema"] })).toThrow();
  });
});
