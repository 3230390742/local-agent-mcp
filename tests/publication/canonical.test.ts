import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  fileSha256,
  sha256Text,
  writeCanonicalJson,
} from "../../src/publication/canonical.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("canonicalJson", () => {
  it("sorts object keys recursively without sorting arrays", () => {
    const left = {
      z: 1,
      a: { y: 2, x: 3 },
      rows: [{ b: 2, a: 1 }, { a: 2 }],
    };
    const right = {
      rows: [{ a: 1, b: 2 }, { a: 2 }],
      a: { x: 3, y: 2 },
      z: 1,
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Text(canonicalJson(left))).toBe(
      sha256Text(canonicalJson(right)),
    );
    expect(canonicalJson(left).indexOf('"b": 2')).toBeLessThan(
      canonicalJson(left).lastIndexOf('"a": 2'),
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("finite");
  });

  it("writes bytes whose file hash matches the text hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lam-canonical-"));
    roots.push(root);
    const file = path.join(root, "manifest.json");
    const text = canonicalJson({ b: 2, a: 1 });

    await writeCanonicalJson(file, { b: 2, a: 1 });

    expect(await fileSha256(file)).toBe(sha256Text(text));
  });
});
