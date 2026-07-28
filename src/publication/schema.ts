import { z } from "zod";

export const publicAgentRunSchema = z
  .object({
    agent: z.enum(["codex", "opencode"]),
    status: z.enum(["passed", "failed"]),
    durationMs: z.number().int().nonnegative(),
    finalMessage: z.string().max(8_000).nullable(),
    activity: z.object({
      commands: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
    }),
    errors: z.array(z.string().max(1_000)).max(10),
  })
  .strict();

export const publicDemoManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    project: z
      .object({
        name: z.literal("local-agent-mcp"),
        version: z.string().min(1),
        repositoryUrl: z.literal(
          "https://github.com/3230390742/local-agent-mcp",
        ),
      })
      .strict(),
    scenario: z
      .object({
        id: z.literal("api-input-validation-review"),
        title: z.literal("API 输入校验审查"),
        prompt: z.string().min(20).max(500),
        workspaceLabel: z.literal("fixtures/public-demo"),
        mode: z.literal("read_only"),
      })
      .strict(),
    policy: z
      .object({
        allowedRoot: z.literal("fixtures/public-demo"),
        writeAllowed: z.literal(false),
        shell: z.literal(false),
        maxConcurrency: z.number().int().min(1).max(8),
        maxOutputBytes: z.number().int().positive(),
      })
      .strict(),
    environment: z
      .object({
        node: z.string().min(1),
        codexAvailable: z.boolean(),
        opencodeAvailable: z.boolean(),
      })
      .strict(),
    stages: z
      .array(
        z
          .object({
            id: z.enum([
              "validate",
              "authorize",
              "execute",
              "parse",
              "redact",
              "publish",
            ]),
            status: z.enum(["passed", "failed"]),
            detail: z.string().min(1).max(240),
          })
          .strict(),
      )
      .length(6),
    comparison: z
      .object({
        note: z.literal(
          "Results are shown without ranking; model output is not a benchmark.",
        ),
        codex: publicAgentRunSchema,
        opencode: publicAgentRunSchema,
      })
      .strict(),
    verification: z
      .object({
        testFilesPassed: z.number().int().positive(),
        testFilesTotal: z.number().int().positive(),
        testsPassed: z.number().int().positive(),
        testsTotal: z.number().int().positive(),
        typecheck: z.literal("passed"),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.verification.testFilesPassed !==
      value.verification.testFilesTotal
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification"],
        message: "all test files must pass",
      });
    }
    if (value.verification.testsPassed !== value.verification.testsTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification"],
        message: "all tests must pass",
      });
    }
  });

export const publicationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("PUBLICATION_OK"),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    checks: z
      .array(
        z.enum([
          "schema",
          "read_only",
          "no_absolute_paths",
          "no_credentials",
          "no_session_ids",
          "verification",
          "source_revision",
        ]),
      )
      .length(7),
  })
  .strict();

export type PublicAgentRun = z.infer<typeof publicAgentRunSchema>;
export type PublicDemoManifest = z.infer<typeof publicDemoManifestSchema>;
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;
