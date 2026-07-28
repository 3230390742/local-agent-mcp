import type { AppConfig } from "../config.js";
import { ConcurrencyManager } from "../concurrency.js";
import type { ToolContext } from "../context.js";
import type { AgentHealthResult } from "../tools/agent-health.js";
import type { AgentCompareInput, AgentCompareResult } from "../tools/agent-compare.js";
import { projectComparison } from "./projector.js";
import {
  PUBLIC_SCENARIO_PROMPT,
  publicDemoManifestSchema,
  type PublicDemoManifest,
} from "./schema.js";
import type { VerificationSummary } from "./verification.js";

export const PUBLIC_SCENARIO = {
  id: "api-input-validation-review",
  title: "API 输入校验审查",
  prompt: PUBLIC_SCENARIO_PROMPT,
  workspaceLabel: "fixtures/public-demo",
  mode: "read_only",
} as const;

export const PUBLIC_OPENCODE_MODEL = "opencode/deepseek-v4-flash-free";

export interface RecorderDependencies {
  now(): Date;
  revision(): Promise<string>;
  health(ctx: ToolContext): Promise<AgentHealthResult>;
  compare(input: AgentCompareInput, ctx: ToolContext): Promise<AgentCompareResult>;
}

export interface RecordPublicDemoOptions {
  fixtureRoot: string;
  projectVersion: string;
  verification: VerificationSummary;
  dependencies: RecorderDependencies;
}

export async function recordPublicDemo(options: RecordPublicDemoOptions): Promise<PublicDemoManifest> {
  const config: AppConfig = {
    allowedRoots: [options.fixtureRoot], allowWrite: false, maxOutputBytes: 1_000_000,
    maxConcurrency: 2, debug: false, defaultTimeoutSeconds: 180,
  };
  const ctx: ToolContext = { config, concurrency: new ConcurrencyManager(config.maxConcurrency) };
  const [health, privateComparison] = await Promise.all([
    options.dependencies.health(ctx),
    options.dependencies.compare({ prompt: PUBLIC_SCENARIO.prompt, cwd: options.fixtureRoot, opencode_model: PUBLIC_OPENCODE_MODEL, parallel: true, timeout_seconds: 180 }, ctx),
  ]);
  if (
    health.allowedRoots.length !== 1 ||
    health.allowedRoots[0] !== options.fixtureRoot ||
    health.writeAllowed ||
    health.maxConcurrency !== config.maxConcurrency
  ) {
    throw new Error("public scenario health policy mismatch");
  }
  const comparison = projectComparison(privateComparison, options.fixtureRoot);
  if (comparison.codex.status !== "passed" || comparison.opencode.status !== "passed") {
    throw new Error("public scenario did not fully pass");
  }
  const manifest = {
    schemaVersion: 1 as const,
    generatedAt: options.dependencies.now().toISOString(),
    sourceRevision: await options.dependencies.revision(),
    project: { name: "local-agent-mcp" as const, version: options.projectVersion, repositoryUrl: "https://github.com/3230390742/local-agent-mcp" as const },
    scenario: PUBLIC_SCENARIO,
    policy: { allowedRoot: "fixtures/public-demo" as const, writeAllowed: false as const, shell: false as const, maxConcurrency: config.maxConcurrency, maxOutputBytes: config.maxOutputBytes },
    environment: { node: health.nodeVersion, codexAvailable: health.codexInstalled, opencodeAvailable: health.opencodeInstalled },
    stages: [
      { id: "validate" as const, status: "passed" as const, detail: "Zod input accepted the fixed public scenario." },
      { id: "authorize" as const, status: "passed" as const, detail: "realpath matched fixtures/public-demo; write mode remained disabled." },
      { id: "execute" as const, status: "passed" as const, detail: "Codex and OpenCode completed independently under the concurrency limit." },
      { id: "parse" as const, status: "passed" as const, detail: "CLI event streams were projected into typed run summaries." },
      { id: "redact" as const, status: "passed" as const, detail: "Private paths, credentials, and session identifiers were removed." },
      { id: "publish" as const, status: "passed" as const, detail: "The canonical manifest is ready for the fail-closed publication audit." },
    ],
    comparison,
    verification: options.verification,
  };
  return publicDemoManifestSchema.parse(manifest);
}
