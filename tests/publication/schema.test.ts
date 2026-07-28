import { describe, expect, it } from "vitest";
import {
  publicationReceiptSchema,
  publicDemoManifestSchema,
} from "../../src/publication/schema.js";

function validManifest(): Record<string, unknown> {
  const run = (agent: "codex" | "opencode") => ({
    agent,
    status: "passed",
    durationMs: 120,
    finalMessage: "Review complete.",
    activity: { commands: 0, files: 0 },
    errors: [],
  });

  return {
    schemaVersion: 1,
    generatedAt: "2026-07-28T00:00:00.000Z",
    sourceRevision: "a".repeat(40),
    project: {
      name: "local-agent-mcp",
      version: "1.0.0",
      repositoryUrl: "https://github.com/3230390742/local-agent-mcp",
    },
    scenario: {
      id: "api-input-validation-review",
      title: "API 输入校验审查",
      prompt: "Review the public API fixture without modifying files.",
      workspaceLabel: "fixtures/public-demo",
      mode: "read_only",
    },
    policy: {
      allowedRoot: "fixtures/public-demo",
      writeAllowed: false,
      shell: false,
      maxConcurrency: 2,
      maxOutputBytes: 1_000_000,
    },
    environment: {
      node: "v24.15.0",
      codexAvailable: true,
      opencodeAvailable: true,
    },
    stages: [
      "validate",
      "authorize",
      "execute",
      "parse",
      "redact",
      "publish",
    ].map((id) => ({ id, status: "passed", detail: `${id} passed` })),
    comparison: {
      note: "Results are shown without ranking; model output is not a benchmark.",
      codex: run("codex"),
      opencode: run("opencode"),
    },
    verification: {
      testFilesPassed: 14,
      testFilesTotal: 14,
      testsPassed: 90,
      testsTotal: 90,
      typecheck: "passed",
    },
  };
}

describe("public artifact schemas", () => {
  const receipt = {
    schemaVersion: 1,
    status: "PUBLICATION_OK",
    manifestSha256: "a".repeat(64),
    checks: ["schema", "read_only", "no_absolute_paths", "no_credentials", "no_session_ids", "verification", "source_revision"],
  };
  it("accepts the complete read-only manifest", () => {
    expect(publicDemoManifestSchema.parse(validManifest()).schemaVersion).toBe(1);
  });

  it("rejects write-enabled policy", () => {
    const value = validManifest();
    (value.policy as Record<string, unknown>).writeAllowed = true;
    expect(() => publicDemoManifestSchema.parse(value)).toThrow();
  });

  it("rejects non-read-only scenarios", () => {
    const value = validManifest();
    (value.scenario as Record<string, unknown>).mode = "workspace_write";
    expect(() => publicDemoManifestSchema.parse(value)).toThrow();
  });

  it("requires a fully passing verification", () => {
    const value = validManifest();
    (value.verification as Record<string, unknown>).testsPassed = 89;
    expect(() => publicDemoManifestSchema.parse(value)).toThrow(
      "all tests must pass",
    );
  });

  it("rejects non-publication receipts", () => {
    expect(() =>
      publicationReceiptSchema.parse({
        schemaVersion: 1,
        status: "FAILED",
        manifestSha256: "a".repeat(64),
        checks: [],
      }),
    ).toThrow();
  });

  it("requires the exact receipt check set", () => {
    expect(() => publicationReceiptSchema.parse({ ...receipt, checks: receipt.checks.slice(0, -1) })).toThrow();
    expect(() => publicationReceiptSchema.parse({ ...receipt, checks: [...receipt.checks.slice(0, -1), "schema"] })).toThrow();
    expect(() => publicationReceiptSchema.parse({ ...receipt, checks: [...receipt.checks.slice(0, -1), "unknown"] })).toThrow();
  });

  it("accepts the receipt check set in a different order", () => {
    expect(() => publicationReceiptSchema.parse({ ...receipt, checks: [...receipt.checks].reverse() })).not.toThrow();
  });
});
