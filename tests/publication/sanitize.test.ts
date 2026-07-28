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
    "///etc/hosts",
    "//server/share/private",
    "path:/opt/private/a.ts",
    "\\\\server\\share\\a.txt",
  ])("removes arbitrary absolute path %s", (raw) => {
    expect(sanitizePublicText(raw, "D:\\Users\\alice\\demo")).not.toContain(
      raw,
    );
  });

  it("neutralizes a Windows path immediately after an ASCII word character", () => {
    expect(
      sanitizePublicText("prefixD:\\Users\\alice\\other\\secret.txt", "D:\\demo"),
    ).toBe("[REDACTED]");
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

  it("replaces a complete authorization header with one neutral marker", () => {
    const secret = "secret-token-123";
    const output = sanitizePublicText(
      `Authorization: Bearer ${secret}`,
      "D:\\demo",
    );
    expect(output).toBe("[REDACTED]");
    expect(output).not.toMatch(/authorization|bearer|secret/i);
  });

  it.each([
    "Authorization: Digest username=alice, realm=private, response=credential",
    '"Authorization": "Bearer credential~with-punctuation"',
    "Authorization: UnknownScheme username=bob credential=private-value",
  ])("neutralizes every authorization header shape through the line", (header) => {
    const output = sanitizePublicText(`${header}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
    expect(output).not.toMatch(
      /authorization|digest|bearer|unknownscheme|alice|bob|credential/i,
    );
  });

  it.each([
    "source C:\\Users\\alice\\Private Folder\\secret name.txt trailing prose",
    "source \\\\server\\private share\\secret name.txt trailing prose",
    "source /opt/private folder/secret name.txt trailing prose",
  ])("neutralizes the rest of a local-path line containing spaces", (line) => {
    expect(sanitizePublicText(line, "D:\\demo")).toBe("[REDACTED]");
  });

  it.each([
    "http://example.com/reviews/42",
    "https://example.com/reviews/42",
    "HTTP://example.com/reviews/42",
    "hTtPs://example.com/reviews/42",
  ])("preserves ordinary public URL %s", (url) => {
    expect(sanitizePublicText(url, "D:\\demo")).toBe(url);
  });

  it.each([
    "https://alice:secret@example.com/review trailing private text",
    "HtTpS://alice@example.com/review trailing private text",
  ])("neutralizes a URI userinfo line %s", (line) => {
    const output = sanitizePublicText(`${line}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
    expect(output).not.toMatch(/alice|secret|@example\.com|trailing private text/i);
  });

  it("preserves HTTP URL spans while masking a root-derived username in prose", () => {
    const root = "D:\\Users\\alice\\demo";
    const prose = "alice reviewed https://alice.example/review and public prose.";

    expect(sanitizePublicText(prose, root)).toBe(
      "<local-username> reviewed https://alice.example/review and public prose.",
    );
    expect(
      sanitizePublicText(
        "https://alice:secret@example.com/review\npublic review",
        root,
      ),
    ).toBe("[REDACTED]\npublic review");
  });

  it.each([
    "ftp://alice:secret@example.test/review trailing private text",
    "CuStOm+V1://alice@example.test/review trailing private text",
  ])("neutralizes non-HTTP URI userinfo line %s", (line) => {
    const output = sanitizePublicText(`${line}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
  });

  it.each([
    "file:///etc/hosts trailing private text",
    "file:///C:/Users/alice/private.txt trailing private text",
  ])("neutralizes local file URI line %s", (line) => {
    const output = sanitizePublicText(`${line}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
  });

  it.each([
    "sessionId=opaque-123",
    "session_id=opaque-123",
    "session-id=opaque-123",
    '"sessionId": "opaque-123"',
    "threadId=thr_private_123",
    "thread_id=thr_private_123",
    "thread-id=thr_private_123",
    '"threadId": "thr_private_123"',
    "session=opaque-123",
    "thread=thr_private_123",
  ])("neutralizes labeled session or thread identifier %s", (label) => {
    const output = sanitizePublicText(`${label}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
    expect(output).not.toContain("opaque-123");
    expect(output).not.toContain("thr_private_123");
  });

  it.each([
    "sessionIdentifier=opaque-123",
    "thread_identifier: private-run",
    "Thread Identifier opaque-123",
    '"sessionIdentifier": "opaque-123"',
  ])("neutralizes labeled session or thread identifier variants %s", (label) => {
    const output = sanitizePublicText(`${label}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
  });

  it.each([
    "session.id=private-run",
    "thread.identifier:opaque",
    "prompt.input=private instruction",
    "user_prompt.content: private request",
  ])("neutralizes dotted private structured label %s", (line) => {
    expect(sanitizePublicText(`${line}\npublic review`, "D:\\demo")).toBe(
      "[REDACTED]\npublic review",
    );
  });

  it("preserves ordinary slash-separated decision text and URL query paths", () => {
    const text = [
      "Decision: approve / defer",
      "https://example.com/login?next=/reviews/42",
    ].join("\n");

    expect(sanitizePublicText(text, "D:\\demo")).toBe(text);
  });

  it.each([
    "Session ID: opaque-123",
    "Thread ID = private-run",
    '"Session ID": "opaque-123"',
    '"Thread ID" = "private-run"',
  ])("neutralizes whitespace-separated session or thread label %s", (label) => {
    const output = sanitizePublicText(`${label}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
  });

  it.each([
    "Session ID opaque-123",
    "Thread ID private-run",
    '"Session ID" "opaque-123"',
  ])("neutralizes delimiter-free explicit session or thread ID %s", (label) => {
    const output = sanitizePublicText(`${label}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
  });

  it("preserves bare session review prose", () => {
    expect(sanitizePublicText("session review", "D:\\demo")).toBe(
      "session review",
    );
  });

  it("preserves ordinary session identification prose", () => {
    expect(sanitizePublicText("session identification review", "D:\\demo")).toBe(
      "session identification review",
    );
  });

  it.each([
    "stderr: internal failure",
    "stderr=internal failure",
    "stderr - internal compiler diagnostic",
    "STDERR - INTERNAL COMPILER DIAGNOSTIC",
    "stderr output: internal compiler diagnostic",
    "STDERR_STREAM - INTERNAL COMPILER DIAGNOSTIC",
    "standard error: internal compiler diagnostic",
  ])(
    "neutralizes stderr-labeled line %s",
    (line) => {
      const output = sanitizePublicText(`${line}\npublic review`, "D:\\demo");
      expect(output).toBe("[REDACTED]\npublic review");
    },
  );

  it.each([
    "stderr output (truncated): proprietary diagnostic",
    "standard error stream (partial) - private",
  ])("neutralizes stderr output with bounded qualifier metadata %s", (line) => {
    expect(sanitizePublicText(`${line}\npublic review`, "D:\\demo")).toBe(
      "[REDACTED]\npublic review",
    );
  });

  it.each([
    "Prompt: reset production database",
    "prompt=private input",
    "User Prompt - private request",
    "user_prompt: private request",
    "system-prompt=private instruction",
    "developer prompt - private guidance",
    "Prompt private instruction",
    "User Prompt private request",
    "system_prompt private instruction",
  ])("neutralizes prompt-labeled line %s", (line) => {
    const output = sanitizePublicText(`${line}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
  });

  it("preserves unrelated prompt prose", () => {
    expect(sanitizePublicText("promptly reviewed", "D:\\demo")).toBe(
      "promptly reviewed",
    );
  });

  it.each([
    "Prompt review complete.",
    "Prompt passed.",
    "Prompt approved",
  ])("preserves reviewed prompt status %s", (status) => {
    expect(sanitizePublicText(status, "D:\\demo")).toBe(status);
  });

  it("continues to neutralize a private whitespace prompt", () => {
    expect(sanitizePublicText("Prompt private instruction", "D:\\demo")).toBe(
      "[REDACTED]",
    );
  });

  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
  ])("neutralizes a complete %s PEM block", (type) => {
    const secret = [
      `-----BEGIN ${type}-----`,
      "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
      `-----END ${type}-----`,
    ].join("\n");
    const output = sanitizePublicText(`${secret}\npublic review`, "D:\\demo");

    expect(output).toBe("[REDACTED]\npublic review");
    expect(output).not.toContain("PRIVATE KEY");
    expect(output).not.toContain("cHJpdmF0ZS1rZXktbWF0ZXJpYWw=");
  });

  it("neutralizes an unterminated PKCS8 PEM block through end of input", () => {
    const output = sanitizePublicText(
      [
        "public review before key",
        "-----BEGIN PRIVATE KEY-----",
        "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
        "still private",
      ].join("\n"),
      "D:\\demo",
    );

    expect(output).toBe("public review before key\n[REDACTED]");
  });

  it("neutralizes a complete PGP private key block", () => {
    const secret = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
      "-----END PGP PRIVATE KEY BLOCK-----",
    ].join("\n");
    const output = sanitizePublicText(`${secret}\npublic review`, "D:\\demo");

    expect(output).toBe("[REDACTED]\npublic review");
    expect(output).not.toContain("PGP PRIVATE KEY BLOCK");
  });

  it("neutralizes an unterminated PGP private key block through end of input", () => {
    const output = sanitizePublicText(
      [
        "public review before key",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
        "still private",
      ].join("\n"),
      "D:\\demo",
    );

    expect(output).toBe("public review before key\n[REDACTED]");
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
