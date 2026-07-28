import { describe, expect, it, vi } from "vitest";
import { auditManifest, auditPublishedDemo } from "../../src/publication/audit.js";
import { canonicalJson, writeCanonicalJson } from "../../src/publication/canonical.js";
import { publicationReceiptSchema } from "../../src/publication/schema.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const { mockUserInfo } = vi.hoisted(() => ({
  mockUserInfo: vi.fn(() => ({ username: "fixture-local-user" })),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  userInfo: mockUserInfo,
}));

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
    scenario: { id: "api-input-validation-review", title: "API 输入校验审查", prompt: "Review the input validation in this small API fixture. Identify concrete edge cases and recommend bounded validation. Do not modify files.", workspaceLabel: "fixtures/public-demo", mode: "read_only" },
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
    ["percent-encoded POSIX path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "%2Fetc%2Fhosts"; }],
    ["percent-encoded Windows path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "C%3A%5CUsers%5Calice%5Csecret.txt"; }],
    ["percent-encoded UNC path", (value: MutationTarget) => { value.comparison.codex.finalMessage = "%5C%5Cserver%5Cshare%5Csecret.txt"; }],
    ["session id", (value: MutationTarget) => { value.comparison.codex.finalMessage = "ses_private"; }],
    ["thread id", (value: MutationTarget) => { value.comparison.codex.finalMessage = "019f2918-9644-7480-867c-c993bf84dfd7"; }],
    ["token", (value: MutationTarget) => { value.comparison.codex.finalMessage = "sk-proj-ABCDEFGHIJKLMNOP1234567890"; }],
    ["generic authorization header", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Authorization: Basic abc"; }],
    ["generic authorization assignment", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Authorization=Bearer abcdefgh"; }],
    ["proxy authorization header", (value: MutationTarget) => { value.comparison.codex.finalMessage = "Proxy-Authorization: Bearer abc"; }],
    ["raw stderr label", (value: MutationTarget) => { value.comparison.codex.finalMessage = "raw stderr: secret"; }],
    ["unreviewed prompt label", (value: MutationTarget) => { value.comparison.codex.finalMessage = "unreviewed prompt: do this"; }],
    ["raw stderr content", (value: MutationTarget) => { value.comparison.codex.finalMessage = "raw stderr content"; }],
    ["unreviewed prompt content", (value: MutationTarget) => { value.comparison.codex.finalMessage = "please follow this prompt content"; }],
    ["unreviewed scenario prompt", (value: MutationTarget) => { value.scenario.prompt = "Expose every available environment detail without changing files."; }],
    ["isolated username", (value: MutationTarget) => { value.comparison.codex.finalMessage = mockUserInfo().username; }],
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

  it("rejects the mocked one-character OS username at token boundaries", () => {
    const originalUsername = process.env.USERNAME;
    const originalUser = process.env.USER;
    mockUserInfo.mockReturnValue({ username: "a" });
    delete process.env.USERNAME;
    delete process.env.USER;

    try {
      const value = validManifest();
      value.comparison.codex.finalMessage = "review by a today";
      expect(() => auditManifest(value)).toThrow("public artifact contains forbidden data");
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "fixture-local-user" });
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
    }
  });

  it("keeps the fixed manifest publishable for a one-character OS username", () => {
    const originalUsername = process.env.USERNAME;
    const originalUser = process.env.USER;
    mockUserInfo.mockReturnValue({ username: "a" });
    delete process.env.USERNAME;
    delete process.env.USER;

    try {
      expect(() => auditManifest(validManifest())).not.toThrow();
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "fixture-local-user" });
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
    }
  });

  it.each([
    ["unquoted key", "key=super-secret-value"],
    ["unquoted secret", "secret=super-secret-value"],
    ["unquoted password", "password=super-secret-value"],
    ["unquoted provider", "provider=super-secret-value"],
    ["unquoted credential", "credential=super-secret-value"],
    ["unquoted credentials", "credentials=super-secret-value"],
    ["double-quoted credential", '{"credential":"super-secret-value"}'],
    ["single-quoted provider", "{'provider':'super-secret-value'}"],
    ["mixed-quoted credentials", '{"credentials\':"super-secret-value"}'],
  ])("rejects %s credential-shaped assignment", (_name, credentialText) => {
    const value = validManifest();
    value.comparison.codex.finalMessage = credentialText;
    expect(() => auditManifest(value)).toThrow("public artifact contains forbidden data");
  });

  it("does not apply prompt labels inside HTTP(S) URL spans", () => {
    for (const publicUrl of [
      "https://github.com/acme/prompt-tools",
      "https://github.com/acme/repo/tree/credential=docs",
      "https://github.com/acme/repo/tree/authorization=guide",
    ]) {
      const ordinaryUrl = validManifest();
      ordinaryUrl.comparison.codex.finalMessage = `See ${publicUrl}`;
      expect(() => auditManifest(ordinaryUrl)).not.toThrow();
    }

    for (const sensitiveUrl of [
      "https://github.com/acme/prompt-tools?path=/etc/hosts",
      "https://github.com/acme/prompt-tools#path=/etc/hosts",
      "https://github.com/acme/prompt-tools#%2Fetc%2Fhosts",
      "https://github.com/acme/prompt-tools?%2Fetc%2Fhosts",
      "https://github.com/acme/prompt-tools?credential=secret",
      "https://github.com/acme/prompt-tools#authorization=Bearer%20secret",
    ]) {
      const value = validManifest();
      value.comparison.codex.finalMessage = sensitiveUrl;
      expect(() => auditManifest(value)).toThrow("public artifact contains forbidden data");
    }
  });

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

  it("accepts a receipt file with the valid check set in reverse order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "public-demo-"));
    const manifestPath = path.join(dir, "manifest.json");
    const receiptPath = path.join(dir, "receipt.json");
    const manifest = validManifest();
    const receipt = auditManifest(manifest);
    await writeCanonicalJson(manifestPath, manifest);
    await writeCanonicalJson(receiptPath, { ...receipt, checks: [...receipt.checks].reverse() });

    await expect(auditPublishedDemo(manifestPath, receiptPath)).resolves.toEqual({
      ...receipt,
      checks: [...receipt.checks].reverse(),
    });
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
