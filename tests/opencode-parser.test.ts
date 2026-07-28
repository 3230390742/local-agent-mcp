import { describe, it, expect } from "vitest";
import { parseOpenCodeOutput } from "../src/parsers/opencode-parser.js";

/**
 * OpenCode JSON parsing tests using real event shapes captured from
 * opencode 1.17.13 plus synthetic tool/error examples.
 */

describe("parseOpenCodeOutput - real captured shape", () => {
  it("extracts session id and concatenated final text", () => {
    const stream = [
      '{"type":"step_start","timestamp":1783100962354,"sessionID":"ses_0d6e6a44cffeWK5YAzWn7kQ55S","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":1783100962354,"sessionID":"ses_0d6e6a44cffeWK5YAzWn7kQ55S","part":{"type":"text","text":"Hi"}}',
      '{"type":"step_finish","timestamp":1783100962354,"sessionID":"ses_0d6e6a44cffeWK5YAzWn7kQ55S","part":{"type":"step-finish","tokens":{"total":13031}}}',
    ].join("\n");

    const r = parseOpenCodeOutput(stream);
    expect(r.sessionId).toBe("ses_0d6e6a44cffeWK5YAzWn7kQ55S");
    expect(r.finalMessage).toBe("Hi");
    expect(r.errors).toHaveLength(0);
  });

  it("concatenates multiple text fragments in order", () => {
    const stream = [
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"Hello "}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"world"}}',
    ].join("\n");
    expect(parseOpenCodeOutput(stream).finalMessage).toBe("Hello world");
  });
});

describe("parseOpenCodeOutput - tools and files", () => {
  it("captures tool invocations and derives file changes", () => {
    const stream = [
      '{"type":"tool","sessionID":"ses_1","part":{"type":"tool","tool":"edit","state":{"status":"completed","input":{"filePath":"src/index.ts"}}}}',
      '{"type":"tool","sessionID":"ses_1","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"}}}}',
    ].join("\n");
    const r = parseOpenCodeOutput(stream);
    expect(r.tools).toHaveLength(2);
    expect(r.tools[0].tool).toBe("edit");
    expect(r.tools[0].target).toBe("src/index.ts");
    expect(r.fileChanges).toContain("src/index.ts");
    // bash is not a file tool; it should not appear in fileChanges.
    expect(r.fileChanges).not.toContain("ls");
  });
});

describe("parseOpenCodeOutput - errors and robustness", () => {
  it("captures top-level error events", () => {
    const stream = '{"type":"error","sessionID":"ses_1","message":"model failed"}';
    const r = parseOpenCodeOutput(stream);
    expect(r.errors).toContain("model failed");
  });

  it("captures error parts", () => {
    const stream =
      '{"type":"step_finish","sessionID":"ses_1","part":{"type":"error","message":"boom"}}';
    const r = parseOpenCodeOutput(stream);
    expect(r.errors).toContain("boom");
  });

  it("collects unparseable lines and handles empty input", () => {
    const r = parseOpenCodeOutput("garbage\n\n{not-json}");
    expect(r.unparsedLines).toContain("garbage");
    expect(r.unparsedLines).toContain("{not-json}");
    expect(r.finalMessage).toBeNull();
  });
});
