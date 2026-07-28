import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps the reviewed fixture text as exact UTF-8 without corruption", async () => {
  const contents = await readFile(
    path.join(process.cwd(), "fixtures", "public-demo", "README.md"),
    "utf8",
  );

  expect(contents).toContain("Reviewed text: 建议为 pageSize 增加 1-100 的整数边界。");
  expect(contents).not.toContain("?");
  expect(contents).not.toContain("\uFFFD");
});
