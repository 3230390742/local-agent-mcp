import { describe, expect, it } from "vitest";
import { sanitizePublicText } from "../../src/publication/sanitize.js";

describe("sanitizePublicText", () => {
  it.each([
    ["D:\\Users\\alice\\demo\\src\\a.ts", "D:\\Users\\alice\\demo"],
    ["/home/alice/demo/src/a.ts", "/home/alice/demo"],
    ["/mnt/d/private/file.ts", "/workspace/demo"],
  ])("removes private path %s", (raw, root) => {
    expect(sanitizePublicText(raw, root)).not.toContain(raw);
  });

  it.each([
    "/workspace/demo/a.ts",
    "/etc/hosts",
    "path:/opt/private/a.ts",
    "\\\\server\\share\\a.txt",
  ])("removes arbitrary absolute path %s", (raw) => {
    expect(sanitizePublicText(raw, "D:\\Users\\alice\\demo")).not.toContain(
      raw,
    );
  });

  it.each([
    ["alice", "D:\\Users\\alice\\demo"],
    ["bob", "/home/bob/demo"],
  ])("removes local username %s outside a path", (username, root) => {
    expect(sanitizePublicText(`${username} reviewed the result`, root)).not.toContain(
      username,
    );
  });

  it("preserves generic directory words and unrelated username substrings", () => {
    const output = sanitizePublicText(
      "Users review malice and alicea together.",
      "D:\\Users\\alice\\demo",
    );
    expect(output).toBe("Users review malice and alicea together.");
  });

  it.each(["ses_secret123", "019f2918-9644-7480-867c-c993bf84dfd7"])(
    "removes session identifier %s",
    (value) => {
      expect(sanitizePublicText(`session=${value}`, "D:\\demo")).not.toContain(
        value,
      );
    },
  );

  it.each([
    "Authorization: Bearer abc123XYZ._-token",
    "sk-proj-ABCDEFGHIJKLMNOP1234567890",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ])("removes credential-shaped value", (value) => {
    const output = sanitizePublicText(value, "D:\\demo");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(value);
  });

  it.each([
    {
      language: "English",
      text: "Reviewed suggestion: pageSize should be an integer from 1-100.",
    },
    {
      language: "Chinese",
      text: "建议为 pageSize 增加 1-100 的整数边界。",
    },
  ])("preserves ordinary $language reviewed text", ({ text }) => {
    expect(sanitizePublicText(text, "D:\\demo")).toBe(text);
  });
});
