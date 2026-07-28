import { describe, expect, it, vi } from "vitest";
import { sanitizePublicText } from "../../src/publication/sanitize.js";

const { mockUserInfo } = vi.hoisted(() => ({
  mockUserInfo: vi.fn(() => ({ username: "" })),
}));

vi.mock("node:os", () => ({ userInfo: mockUserInfo }));

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
    "\\Users\\alice\\secret.txt",
    "/",
  ])("removes arbitrary absolute path %s", (raw) => {
    expect(sanitizePublicText(raw, "D:\\Users\\alice\\demo")).not.toContain(
      raw,
    );
  });

  it.each([
    "%2Fetc%2Fhosts",
    "C%3A%5CUsers%5Calice%5Csecret.txt",
    "%5C%5Cserver%5Cshare%5Csecret.txt",
    "%5CUsers%5Calice%5Csecret.txt",
  ])("neutralizes a standalone percent-encoded absolute path %s", (raw) => {
    expect(sanitizePublicText(raw, "D:\\Users\\alice\\demo")).toBe("[REDACTED]");
  });

  it("fails closed for invalid percent encoding outside an HTTP(S) URL", () => {
    expect(sanitizePublicText("review location %ZZ", "D:\\demo")).toBe("[REDACTED]");
  });

  it.each([
    "%252Fetc%252Fhosts",
    "%25252Fetc%25252Fhosts",
    "C%253A%255CUsers%255Calice%255Csecret.txt",
    "path=C%253A%255CUsers%255Calice%255Csecret.txt",
    "C%25253A%25255CUsers%25255Calice%25255Csecret.txt",
    "%255C%255Cserver%255Cshare%255Csecret.txt",
    "%25255C%25255Cserver%25255Cshare%25255Csecret.txt",
  ])("neutralizes a recursively percent-encoded standalone absolute path %s", (raw) => {
    expect(sanitizePublicText(raw, "D:\\Users\\alice\\demo")).toBe("[REDACTED]");
  });

  it("preserves a mid-word encoded drive-like label without a path", () => {
    const originalUsername = process.env.USERNAME;
    const originalUser = process.env.USER;
    mockUserInfo.mockReturnValue({ username: "" });
    delete process.env.USERNAME;
    delete process.env.USER;

    try {
      expect(sanitizePublicText("metricC%3A is a label", "D:\\demo")).toBe(
        "metricC%3A is a label",
      );
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "" });
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
    }
  });

  it.each([
    "prefixC%3A%5CUsers%5Calice%5Csecret.txt",
    "prefixC%253A%255CUsers%255Calice%255Csecret.txt",
  ])("redacts a prefixed encoded Windows drive path %s", (text) => {
    expect(sanitizePublicText(text, "D:\\demo")).toBe("[REDACTED]");
  });

  it.each([
    "Coverage is 100%complete",
    "Coverage is 100%beef",
    "Coverage is 100%dead",
    "Review confidence: 100% approved.",
    "Review confidence: 100%",
  ])("preserves ordinary percentage prose %s", (text) => {
    expect(sanitizePublicText(text, "D:\\demo")).toBe(text);
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
    "Proxy-Authorization: Basic dXNlcjpwYXNz",
    "proxy_authorization: Basic dXNlcjpwYXNz",
    "proxy authorization=Basic dXNlcjpwYXNz",
  ])("neutralizes every authorization header shape through the line", (header) => {
    const output = sanitizePublicText(`${header}\npublic review`, "D:\\demo");
    expect(output).toBe("[REDACTED]\npublic review");
    expect(output).not.toMatch(
      /proxy|authorization|digest|bearer|basic|unknownscheme|alice|bob|credential|dXNlcjpwYXNz/i,
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
    "https://github.com/acme/prompt-tools",
    "https://github.com/acme/repo/tree/credential=docs",
    "https://github.com/acme/repo/tree/authorization=guide",
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

  it("neutralizes an HTTP URL containing a root-derived username", () => {
    const root = "D:\\Users\\alice\\demo";

    expect(sanitizePublicText("https://alice.example/review", root)).toBe(
      "[REDACTED]",
    );
    expect(
      sanitizePublicText(
        "https://alice:secret@example.com/review\npublic review",
        root,
      ),
    ).toBe("[REDACTED]\npublic review");
  });

  it.each([
    "https://example.test/view?path=/home/alice/private.txt",
    "https://example.test/view#path=/home/alice/private.txt",
    "https://example.test/view?next=/etc/hosts",
    "https://example.test/view#return=/etc/hosts",
    "https://example.test/view?next=%2Fetc%2Fhosts",
    "https://example.test/view?next=%252Fetc%252Fhosts",
    "https://example.test/view#next=C%253A%255CUsers%255Calice%255Csecret.txt",
    "https://example.test/view?next=%25255C%25255Cserver%25255Cshare%25255Csecret.txt",
    "https://github.com/acme/prompt-tools#%2Fetc%2Fhosts",
    "https://github.com/acme/prompt-tools?%2Fetc%2Fhosts",
    "https://example.test/view#path=%2Fetc%2Fhosts",
  ])("neutralizes an HTTP URL with filesystem data in query or fragment", (url) => {
    expect(sanitizePublicText(url, "D:\\demo")).toBe("[REDACTED]");
  });

  it.each([
    "https://example.test/view?credential=secret",
    "https://example.test/view#authorization=Bearer%20secret",
    "https://example.test/view?api_key=secret",
    "https://example.test/view#user_prompt=private",
    "https://example.test/view?stderr=private",
  ])("neutralizes an HTTP URL with a sensitive query or fragment key", (url) => {
    expect(sanitizePublicText(url, "D:\\demo")).toBe("[REDACTED]");
  });

  it("fails closed for invalid percent encoding in an HTTP query or fragment", () => {
    expect(
      sanitizePublicText("https://example.test/view?next=%ZZ", "D:\\demo"),
    ).toBe("[REDACTED]");
  });

  it("redacts the configured local username with the fixed scenario root", () => {
    const originalUsername = process.env.USERNAME;
    process.env.USERNAME = "fixture-local-user";

    try {
      expect(
        sanitizePublicText(
          "fixture-local-user reviewed the result",
          "D:\\code\\local-agent-mcp\\fixtures\\public-demo",
        ),
      ).toBe("<local-username> reviewed the result");
    } finally {
      if (originalUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalUsername;
      }
    }
  });

  it("preserves ordinary prose for an OS-provided one-character username", () => {
    const originalUsername = process.env.USERNAME;
    const originalUser = process.env.USER;
    mockUserInfo.mockReturnValue({ username: "a" });
    delete process.env.USERNAME;
    delete process.env.USER;

    try {
      expect(
        sanitizePublicText(
          "review by a maintainer with a 4xx error",
          "D:\\code\\local-agent-mcp\\fixtures\\public-demo",
        ),
      ).toBe("review by a maintainer with a 4xx error");
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "" });
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
    }
  });

  it.each([
    "username: a",
    "user=a",
    "account: a",
    "owner=a",
  ])("neutralizes an identity-labelled one-character username: %s", (value) => {
    const originalUsername = process.env.USERNAME;
    const originalUser = process.env.USER;
    mockUserInfo.mockReturnValue({ username: "a" });
    delete process.env.USERNAME;
    delete process.env.USER;

    try {
      expect(sanitizePublicText(value, "D:\\demo")).toBe("[REDACTED]");
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "" });
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
    }
  });

  it("protects an exact one-character username and URL or path provenance", () => {
    const originalUsername = process.env.USERNAME;
    const originalUser = process.env.USER;
    mockUserInfo.mockReturnValue({ username: "a" });
    delete process.env.USERNAME;
    delete process.env.USER;

    try {
      expect(sanitizePublicText("a", "D:\\Users\\a\\demo")).toBe(
        "<local-username>",
      );
      expect(
        sanitizePublicText("D:\\Users\\a\\demo\\secret.txt", "D:\\demo"),
      ).toBe("[REDACTED]");
      expect(
        sanitizePublicText("https://a.example.test/review", "D:\\Users\\a\\demo"),
      ).toBe("[REDACTED]");
      expect(
        sanitizePublicText("https://a@example.test/review", "D:\\demo"),
      ).toBe("[REDACTED]");
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "" });
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
    }
  });

  it("continues when the OS account lookup fails", () => {
    mockUserInfo.mockImplementationOnce(() => {
      throw new Error("OS account lookup failed");
    });

    try {
      expect(
        sanitizePublicText(
          "public review",
          "D:\\code\\local-agent-mcp\\fixtures\\public-demo",
        ),
      ).toBe("public review");
      expect(mockUserInfo).toHaveBeenCalledTimes(1);
    } finally {
      mockUserInfo.mockReset().mockReturnValue({ username: "" });
    }
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

  it("preserves ordinary slash-separated decision text and non-absolute URL query paths", () => {
    const text = [
      "Decision: approve / defer",
      "https://example.com/login?next=reviews/42",
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
    "prompt_preview: private preview",
    "promptPreview=private preview",
    "user_prompt_preview: private preview",
    "system-promptPreview=private preview",
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
