import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readVitestSummary } from "../../src/publication/verification.js";

async function summary(value: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vitest-summary-"));
  const file = path.join(dir, "summary.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

describe("readVitestSummary", () => {
  it("rejects malformed JSON", async () => {
    const file = await summary("not-json");
    await writeFile(file, "{", "utf8");
    await expect(readVitestSummary(file)).rejects.toThrow();
  });

  it.each([
    {},
    { numPassedTestSuites: "1", numTotalTestSuites: 1, numPassedTests: 1, numTotalTests: 1 },
    { numPassedTestSuites: 0, numTotalTestSuites: 0, numPassedTests: 1, numTotalTests: 1 },
    { numPassedTestSuites: -1, numTotalTestSuites: -1, numPassedTests: 1, numTotalTests: 1 },
    { numPassedTestSuites: 1, numTotalTestSuites: 1, numPassedTests: 0, numTotalTests: 0 },
    { numPassedTestSuites: 1, numTotalTestSuites: 1, numPassedTests: -1, numTotalTests: -1 },
    { numPassedTestSuites: 1, numTotalTestSuites: 2, numPassedTests: 1, numTotalTests: 1 },
    { numPassedTestSuites: 1, numTotalTestSuites: 1, numPassedTests: 1, numTotalTests: 2 },
  ])("rejects invalid summary %j", async (value) => {
    await expect(readVitestSummary(await summary(value))).rejects.toThrow();
  });

  it("derives all counts from JSON", async () => {
    await expect(readVitestSummary(await summary({ numPassedTestSuites: 2, numTotalTestSuites: 2, numPassedTests: 3, numTotalTests: 3 }))).resolves.toEqual({ testFilesPassed: 2, testFilesTotal: 2, testsPassed: 3, testsTotal: 3, typecheck: "passed" });
  });
});
