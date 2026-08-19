import { describe, test, expect } from "vitest";
import { PromptScriptError, psError } from "../src/errors.js";

describe("PromptScriptError", () => {
  test("结构：stage/file/line/code/message 全部携带", () => {
    const e = psError("parse", "a.ps", 3, "E_SYNTAX", "坏语法");
    expect(e).toBeInstanceOf(Error);
    expect(e.stage).toBe("parse");
    expect(e.file).toBe("a.ps");
    expect(e.line).toBe(3);
    expect(e.code).toBe("E_SYNTAX");
    expect(e.message).toContain("坏语法");
  });

  test("toString 格式：file:line: [CODE] message", () => {
    const e = psError("load", "a.ps", 0, "E_INCLUDE_MISSING", "找不到文件");
    expect(`${e}`).toBe("a.ps:0: [E_INCLUDE_MISSING] 找不到文件");
  });

  test("直接 new 同样成立（无需工厂）", () => {
    const e = new PromptScriptError({ stage: "render", file: "x", line: 1, code: "E_UNBOUND", message: "m" });
    expect(e.stage).toBe("render");
  });
});
