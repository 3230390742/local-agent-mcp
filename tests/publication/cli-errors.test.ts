import { describe, expect, it } from "vitest";
import { formatRecordFailure, formatAuditFailure } from "../../src/cli/errors.js";

describe("public demo CLI errors", () => {
  it("preserves only the known safe record failure", () => {
    expect(formatRecordFailure(new Error("public scenario did not fully pass"))).toBe("public scenario did not fully pass");
    expect(formatRecordFailure(new Error("D:\\Users\\alice\\secret.txt"))).toBe("public demo record failed");
  });

  it("normalizes all audit failures", () => {
    expect(formatAuditFailure(new Error("/private/secret"))).toBe("public demo audit failed");
  });
});
