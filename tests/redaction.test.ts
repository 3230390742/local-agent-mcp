import { describe, it, expect } from "vitest";
import { redact } from "../src/redaction.js";

/**
 * Redaction tests: tokens, API keys, and authorization headers must be masked.
 */

describe("redact", () => {
  it("masks Authorization Bearer headers", () => {
    const out = redact("Authorization: Bearer abc123XYZ._-token");
    expect(out).not.toContain("abc123XYZ");
    expect(out.toLowerCase()).toContain("bearer");
    expect(out).toContain("[REDACTED]");
  });

  it("masks standalone bearer tokens", () => {
    const out = redact("using bearer sk1234567890abcdef to auth");
    expect(out).not.toContain("sk1234567890abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("masks OpenAI-style sk- keys", () => {
    const out = redact("key sk-proj-ABCDEFGHIJKLMNOP1234567890 done");
    expect(out).not.toContain("ABCDEFGHIJKLMNOP1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("masks GitHub tokens", () => {
    const out = redact("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 x");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).toContain("[REDACTED]");
  });

  it("masks key=value secret assignments", () => {
    const out = redact('api_key="supersecretvalue123" and password=hunter2');
    expect(out).not.toContain("supersecretvalue123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  it("masks JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4";
    const out = redact(`token=${jwt}`);
    expect(out).not.toContain("SflKxwRJSMeKKF2QT4");
    expect(out).toContain("[REDACTED]");
  });

  it("masks AWS access key ids", () => {
    const out = redact("aws AKIAIOSFODNN7EXAMPLE here");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("leaves ordinary text untouched", () => {
    const text = "This is a normal message about refactoring the parser.";
    expect(redact(text)).toBe(text);
  });

  it("coerces non-string input without throwing", () => {
    expect(redact(12345)).toBe("12345");
    expect(redact(null)).toBe("null");
  });
});
