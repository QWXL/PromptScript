import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const grammarPath = path.resolve(fileURLToPath(import.meta.url), "../../syntaxes/promptscript.tmLanguage.json");
const grammar = JSON.parse(readFileSync(grammarPath, "utf8")) as {
  scopeName: string; fileTypes: string[]; patterns: unknown[];
};

describe("TextMate 语法", () => {
  test("结构合法：scopeName/fileTypes/patterns", () => {
    expect(grammar.scopeName).toBe("source.promptscript");
    expect(grammar.fileTypes).toContain("ps");
    expect(Array.isArray(grammar.patterns)).toBe(true);
  });

  test("指令关键字齐全", () => {
    const s = JSON.stringify(grammar);
    for (const kw of ["@set", "@if", "@else", "@include", "@for"]) expect(s).toContain(kw);
  });
});
