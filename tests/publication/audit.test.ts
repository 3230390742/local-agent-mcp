import { describe, expect, it } from "vitest";
import { auditManifest, auditPublishedDemo } from "../../src/publication/audit.js";
import { canonicalJson, writeCanonicalJson } from "../../src/publication/canonical.js";
import { publicationReceiptSchema } from "../../src/publication/schema.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { userInfo } from "node:os";

interface MutationTarget {
  policy: { writeAllowed: boolean };
  comparison: { codex: { finalMessage: string | null } };
  verification: { testsPassed: number };
  sourceRevision: string;
  stages: Array<{ id: string; status: string; detail: string }>;
  scenario: { prompt: string };
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
    ["POSIX path assignment", (value: MutationTarget) => { value.comparison.codex.finalMessage = "prefix=/etc/hosts"; }],
    ["UNC path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "\\\\server\\share\\secret.txt"; }],
    ["session id", (value: MutationTarget) => { value.comparison.codex.finalMessage = "ses_private"; }],
    ["thread id", (value: MutationTarget) => { value.comparison.codex.finalMessage = "019f2918-9644-7480-867c-c993bf84dfd7"; }],
    ["token", (value: MutationTarget) => { value.comparison.codex.finalMessage = "sk-proj-ABCDEFGHIJKLMNOP1234567890"; }],
    ["provider credential", (value: MutationTarget) => { value.comparison.codex.finalMessage = "provider=super-secret-value"; }],
    ["generic authorization header", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Authorization: Basic abc"; }],
    ["generic authorization assignment", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Authorization=Bearer abcdefgh"; }],
    ["proxy authorization header", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Proxy-Authorization: Bearer abc"; }],
    ["raw stderr label", (value: MutationTarget) => { value.comparison.codex.finalMessage = "raw stderr: secret"; }],
    ["unreviewed prompt label", (value: MutationTarget) => { value.comparison.codex.finalMessage = "unreviewed prompt: do this"; }],
    ["raw stderr content", (value: MutationTarget) => { value.comparison.codex.finalMessage = "raw stderr content"; }],
    ["unreviewed prompt content", (value: MutationTarget) => { value.comparison.codex.finalMessage = "please follow this prompt content"; }],
    ["unreviewed scenario prompt", (value: MutationTarget) => { value.scenario.prompt = "run this unreviewed prompt"; }],
    ["isolated username", (value: MutationTarget) => { value.comparison.codex.finalMessage = userInfo().username; }],
    ["failed tests", (value: MutationTarget) => { value.verification.testsPassed -= 1; }],
    ["bad revision", (value: MutationTarget) => { value.sourceRevision = "abc"; }],
  ])("rejects %s", (_name, mutate) => {
    const value = validManifest();
    mutate(value);
    expect(() => auditManifest(value)).toThrow();
  });

  it("requires the exact ordered stages", () => {
    const duplicate = validManifest();
    duplicate.stages[1] = { ...duplicate.stages[0] };
    expect(() => auditManifest(duplicate)).toThrow();
    const reordered = validManifest();
    [reordered.stages[0], reordered.stages[1]] = [reordered.stages[1], reordered.stages[0]];
    expect(() => auditManifest(reordered)).toThrow();
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

  it.each([
    ["duplicate", ["schema", "schema", "read_only", "no_absolute_paths", "no_credentials", "no_session_ids", "verification"]],
    ["unknown", ["schema", "read_only", "no_absolute_paths", "no_credentials", "no_session_ids", "verification", "unknown"]],
  ])("rejects %s receipt checks", (_name, checks) => {
    expect(() => publicationReceiptSchema.parse({ ...auditManifest(validManifest()), checks })).toThrow();
  });

  it("accepts a reordered receipt set", () => {
    const receipt = auditManifest(validManifest());
    expect(() => publicationReceiptSchema.parse({ ...receipt, checks: [...receipt.checks].reverse() })).not.toThrow();
  });
});
