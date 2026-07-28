import { describe, it, expect } from "vitest";
import { parseCodexOutput } from "../src/parsers/codex-parser.js";

/**
 * Codex JSONL parsing tests using real event shapes captured from
 * codex-cli 0.142.5 plus synthetic examples of the item/legacy formats.
 */

describe("parseCodexOutput - thread/turn/item format", () => {
  it("extracts thread id, final message, commands, and file changes", () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"019f2918-9644-7480-867c-c993bf84dfd7"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls -la","exit_code":0,"aggregated_output":"file1\\nfile2"}}',
      '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/a.ts","kind":"modified"}]}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done analyzing."}}',
      '{"type":"turn.completed","usage":{"input_tokens":10}}',
    ].join("\n");

    const r = parseCodexOutput(jsonl);
    expect(r.threadId).toBe("019f2918-9644-7480-867c-c993bf84dfd7");
    expect(r.finalMessage).toBe("Done analyzing.");
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].command).toBe("ls -la");
    expect(r.commands[0].exitCode).toBe(0);
    expect(r.fileChanges).toEqual([{ path: "src/a.ts", kind: "modified" }]);
    expect(r.errors).toHaveLength(0);
  });

  it("captures error events (real usage-limit shape)", () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You\'ve hit your usage limit."}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
    ].join("\n");

    const r = parseCodexOutput(jsonl);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors[0]).toContain("usage limit");
    expect(r.finalMessage).toBeNull();
  });

  it("uses the last agent_message when several are present", () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
    ].join("\n");
    expect(parseCodexOutput(jsonl).finalMessage).toBe("second");
  });
});

describe("parseCodexOutput - legacy msg format", () => {
  it("extracts agent_message and errors from msg envelopes", () => {
    const jsonl = [
      '{"msg":{"type":"agent_message","message":"legacy answer"}}',
      '{"msg":{"type":"error","message":"legacy error"}}',
    ].join("\n");
    const r = parseCodexOutput(jsonl);
    expect(r.finalMessage).toBe("legacy answer");
    expect(r.errors).toContain("legacy error");
  });
});

describe("parseCodexOutput - robustness", () => {
  it("collects unparseable lines without throwing", () => {
    const jsonl = ["not json", "{bad}", '{"type":"turn.started"}'].join("\n");
    const r = parseCodexOutput(jsonl);
    expect(r.unparsedLines).toContain("not json");
    expect(r.unparsedLines).toContain("{bad}");
  });

  it("handles empty input", () => {
    const r = parseCodexOutput("");
    expect(r.finalMessage).toBeNull();
    expect(r.events).toHaveLength(0);
  });

  it("truncates long command output previews", () => {
    const big = "x".repeat(5000);
    const jsonl = `{"type":"item.completed","item":{"type":"command_execution","command":"cmd","aggregated_output":"${big}"}}`;
    const r = parseCodexOutput(jsonl);
    expect(r.commands[0].outputPreview!.length).toBeLessThan(big.length);
    expect(r.commands[0].outputPreview).toContain("[truncated]");
  });
});
