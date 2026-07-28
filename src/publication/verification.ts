import { readFile } from "node:fs/promises";

export interface VerificationSummary {
  testFilesPassed: number;
  testFilesTotal: number;
  testsPassed: number;
  testsTotal: number;
  typecheck: "passed";
}

export async function readVitestSummary(file: string): Promise<VerificationSummary> {
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (value.success !== true) {
    throw new Error("verification did not fully pass");
  }
  const fields = ["numPassedTestSuites", "numTotalTestSuites", "numPassedTests", "numTotalTests"] as const;
  if (fields.some((field) => typeof value[field] !== "number")) {
    throw new Error("invalid Vitest summary");
  }
  const summary: VerificationSummary = {
    testFilesPassed: Number(value.numPassedTestSuites),
    testFilesTotal: Number(value.numTotalTestSuites),
    testsPassed: Number(value.numPassedTests),
    testsTotal: Number(value.numTotalTests),
    typecheck: "passed",
  };
  for (const count of [summary.testFilesPassed, summary.testFilesTotal, summary.testsPassed, summary.testsTotal]) {
    if (!Number.isInteger(count) || count <= 0) throw new Error("invalid Vitest summary");
  }
  if (summary.testFilesPassed !== summary.testFilesTotal || summary.testsPassed !== summary.testsTotal) {
    throw new Error("verification did not fully pass");
  }
  return summary;
}
