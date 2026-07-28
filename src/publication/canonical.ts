import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function normalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, normalize(input[key])]),
    );
  }
  throw new Error(`unsupported canonical value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function fileSha256(file: string): Promise<string> {
  return sha256Text(await readFile(file, "utf8"));
}

export async function writeCanonicalJson(
  file: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, canonicalJson(value), { encoding: "utf8", flag: "w" });
}
