import { describe, test, expect } from "vitest";
import { scanLine, scanParts, stripComments } from "../src/lexer.js";
import { PromptScriptError } from "../src/errors.js";

const err = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as PromptScriptError).code).toBe(code); return; }
  throw new Error(`期望抛出 ${code} 但没抛`);
};

describe("scanLine 行分类", () => {
  test("blank：空行/纯空白", () => {
    expect(scanLine("", 1, "article").kind).toBe("blank");
    expect(scanLine("   ", 2, "article").kind).toBe("blank");
    expect(scanLine("\t", 3, "code").kind).toBe("blank");
  });

  test("directive：已知指令，payload 截取（指令名后原文）", () => {
    expect(scanLine("  @if(x > 1) {", 1, "article").directive).toBe("if");
    expect(scanLine("  @if(x > 1) {", 1, "article").payload).toBe("(x > 1) {");
    expect(scanLine("@else {", 2, "code").directive).toBe("else");
    expect(scanLine('@include("a.ps")', 3, "code").directive).toBe("include");
  });

  test("directive：@for 识别 + payload 截取", () => {
    expect(scanLine("@for v in tags {", 1, "article").directive).toBe("for");
    expect(scanLine("@for v in tags {", 1, "article").payload).toBe("v in tags {");
    expect(scanLine("@for k, v in tags {", 1, "code").directive).toBe("for");
    expect(scanLine("@for i in 1..5 {", 1, "code").directive).toBe("for");
  });

  test("unknown directive：@ 开头但非已知 → E_UNKNOWN_DIRECTIVE", () => {
    err(() => scanLine("@end", 1, "article"), "E_UNKNOWN_DIRECTIVE");
    err(() => scanLine("  @iff(a)", 2, "article"), "E_UNKNOWN_DIRECTIVE");
    err(() => scanLine("@forx", 1, "article"), "E_UNKNOWN_DIRECTIVE");
  });

  test("close：trimStart 后恰为 }", () => {
    expect(scanLine("}", 1, "code").kind).toBe("close");
    expect(scanLine("  }  ", 2, "code").kind).toBe("close");
  });

  test("closeElse：} @else 同行连接（空白容忍，payload 为 @else 之后内容）", () => {
    expect(scanLine("} @else {", 1, "code")).toEqual({ kind: "closeElse", line: 1, text: "} @else {", payload: "{" });
    expect(scanLine("}@else{", 2, "code").kind).toBe("closeElse");
    expect(scanLine("} @else @if(b) {", 3, "code")).toEqual({ kind: "closeElse", line: 3, text: "} @else @if(b) {", payload: "@if(b) {" });
    expect(scanLine("} @else", 4, "code")).toEqual({ kind: "closeElse", line: 4, text: "} @else", payload: "" });
    expect(scanLine("  } @else {", 5, "code").kind).toBe("closeElse");
  });

  test("close 行错误：} 后非 @else 连接仍报错", () => {
    err(() => scanLine("} x", 1, "code"), "E_SYNTAX");
    err(() => scanLine("} @elsex", 2, "code"), "E_SYNTAX");
  });

  test("close 后有多余内容 → 错误", () => {
    err(() => scanLine("} x", 1, "code"), "E_SYNTAX");
  });

  test("code 模式非字符串行 → E_EXPECT_STRING", () => {
    err(() => scanLine("随便写的文本", 1, "code"), "E_EXPECT_STRING");
    err(() => scanLine('"开头但没闭合', 2, "code"), "E_UNCLOSED_STRING");
  });

  test("raw：文章模式普通行（行首空白保留）", () => {
    const l = scanLine("  你好 {user.vip}", 1, "article");
    expect(l.kind).toBe("raw");
    expect(l.text).toBe("  你好 {user.vip}");
  });
});

describe("scanParts 槽位（文章行）", () => {
  test("纯文本 → 单 text 段；转义解码 \\{ \\} \\\\", () => {
    expect(scanParts("a\\{b\\}c", "f", 1, {})).toEqual([{ text: "a{b}c" }]);
    expect(scanParts("x\\\\y", "f", 1, {})).toEqual([{ text: "x\\y" }]);
  });

  test("简单槽位", () => {
    expect(scanParts("你好{user.vip}!", "f", 1, {})).toEqual([
      { text: "你好" }, { expr: "user.vip" }, { text: "!" },
    ]);
  });

  test("槽内嵌套引号不闭合：{a ?? \"x}\"} 整体一个槽", () => {
    expect(scanParts('v{a ?? "x}y"}w', "f", 1, {})).toEqual([
      { text: "v" }, { expr: 'a ?? "x}y"' }, { text: "w" },
    ]);
  });

  test("记录字面量在槽内：深度递归", () => {
    expect(scanParts('{r["k"] ?? "d"}', "f", 1, {})).toEqual([
      { expr: 'r["k"] ?? "d"' },
    ]);
  });

  test("槽内引号外 } 需转义：\\} 保留", () => {
    expect(scanParts("{a ?? x\\}y}", "f", 1, {})).toEqual([
      { expr: "a ?? x}y" },
    ]);
  });

  test("未闭合槽位 → E_UNCLOSED_SLOT", () => {
    err(() => scanParts("{a", "f", 1, {}), "E_UNCLOSED_SLOT");
  });

  test("文章行孤立 } → E_STRAY_BRACE（转义可逃逸）", () => {
    err(() => scanParts("a}b", "f", 1, {}), "E_STRAY_BRACE");
    expect(scanParts("a\\}b", "f", 1, {})).toEqual([{ text: "a}b" }]);
  });
});

describe("scanParts 字符串字面量", () => {
  test("基础：引号解码 + \\n \\t 转义", () => {
    expect(scanParts('"a\\tb\\nc"', "f", 1, { outerQuote: '"' })).toEqual([{ text: "a\tb\nc" }]);
  });

  test("插值：{expr} 与文本混合，内层引号感知", () => {
    expect(scanParts('"今天{env.weather ?? "未知"}天"', "f", 1, { outerQuote: '"' })).toEqual([
      { text: "今天" }, { expr: 'env.weather ?? "未知"' }, { text: "天" },
    ]);
  });

  test("外层引号闭合规则：深度 0 的引号结束字符串", () => {
    expect(scanParts("'it\\'s {a}'", "f", 1, { outerQuote: "'" })).toEqual([
      { text: "it's " }, { expr: "a" },
    ]);
  });

  test("\\{ 在字符串内输出字面 {", () => {
    expect(scanParts('"a\\{b"', "f", 1, { outerQuote: '"' })).toEqual([{ text: "a{b" }]);
  });

  test("未闭合字符串 → E_UNCLOSED_STRING", () => {
    err(() => scanParts('"abc', "f", 1, { outerQuote: '"' }), "E_UNCLOSED_STRING");
  });

  test("字符串字面量后存在多余内容 → E_SYNTAX", () => {
    expect(() => scanParts('"abc"def', "f", 1, { outerQuote: '"' })).toThrow();
    err(() => scanParts('"abc"def', "f", 1, { outerQuote: '"' }), "E_SYNTAX");
  });

  test("结尾恰为外层引号：正常返回", () => {
    expect(scanParts('"abc"', "f", 1, { outerQuote: '"' })).toEqual([{ text: "abc" }]);
  });

  test("scanLine code 模式字符串后有尾随内容 → E_SYNTAX", () => {
    err(() => scanLine('"abc"def', 1, "code"), "E_SYNTAX");
  });

  test("前导空白（代码模式缩进）：开头引号仍识别为开头，空白不入内容", () => {
    expect(scanLine('  "abc"', 1, "code").kind).toBe("literal");
    expect(scanParts('  "abc"', "f", 1, { outerQuote: '"' })).toEqual([{ text: "abc" }]);
    expect(scanParts('\t"abc"', "f", 1, { outerQuote: '"' })).toEqual([{ text: "abc" }]);
  });

  test("文章模式（无 outerQuote）：前导空白是内容，不受影响", () => {
    expect(scanParts("  a", "f", 1, {})).toEqual([{ text: "  a" }]);
  });
});

describe("stripComments（C 风格注释）", () => {
  const st = (): { inBlock: boolean; startLine: number } => ({ inBlock: false, startLine: 0 });

  test("行首 // 整行注释 → null（含前导空白）", () => {
    expect(stripComments("// 注释", "f", 1, st(), false)).toBeNull();
    expect(stripComments("  // 注释", "f", 1, st(), false)).toBeNull();
    expect(stripComments("//", "f", 1, st(), false)).toBeNull();
  });

  test("行首转义 \\// 与 \\/* → 剥掉反斜杠的内容行", () => {
    expect(stripComments("\\// 代码注释", "f", 1, st(), false)).toBe("// 代码注释");
    expect(stripComments("  \\/* 内容", "f", 1, st(), false)).toBe("  /* 内容");
    expect(stripComments("\\/* 内容", "f", 1, st(), false)).toBe("/* 内容");
  });

  test("行首 /* */ 单行：纯注释 → null；后接内容 → 剩余内容", () => {
    expect(stripComments("/* c */", "f", 1, st(), false)).toBeNull();
    expect(stripComments("/**/", "f", 1, st(), false)).toBeNull();
    expect(stripComments("/* c */ 正文", "f", 1, st(), false)).toBe(" 正文");
    expect(stripComments("/* c */ // note", "f", 1, st(), false)).toBeNull();
    expect(stripComments("/* a /* b */", "f", 1, st(), false)).toBeNull(); // 不嵌套：第一个 */ 关闭
  });

  test("跨行块注释：中间行整体擦除，*/ 后剩余内容恢复", () => {
    const s = st();
    expect(stripComments("/*", "f", 1, s, false)).toBeNull();
    expect(s.inBlock).toBe(true);
    expect(stripComments("* 中间行", "f", 2, s, false)).toBeNull();
    expect(stripComments("*/ 尾行", "f", 3, s, false)).toBe(" 尾行");
    expect(s.inBlock).toBe(false);
  });

  test("行首孤立 */ → E_COMMENT_STRAY", () => {
    err(() => stripComments("*/ x", "f", 1, st(), false), "E_COMMENT_STRAY");
  });

  test("指令行尾部 // 截断，引号感知", () => {
    expect(stripComments("@set x = a // note", "f", 1, st(), false)).toBe("@set x = a ");
    expect(stripComments('@set x = "a//b"', "f", 1, st(), false)).toBe('@set x = "a//b"');
    expect(stripComments('@set x = "a//b" // note', "f", 1, st(), false)).toBe('@set x = "a//b" ');
    expect(stripComments('@include("sub//x.ps")', "f", 1, st(), false)).toBe('@include("sub//x.ps")');
  });

  test("指令行行内 /* */ 剥离；未闭合 → 进跨行块", () => {
    expect(stripComments("@set x = a /* c */ b", "f", 1, st(), false)).toBe("@set x = a  b");
    const s = st();
    expect(stripComments("@set x = a /* 未闭合", "f", 1, s, false)).toBe("@set x = a ");
    expect(s.inBlock).toBe(true);
  });

  test("指令行孤立 */ → E_COMMENT_STRAY", () => {
    err(() => stripComments("@set x = a */ b", "f", 1, st(), false), "E_COMMENT_STRAY");
  });

  test("代码模式行尾部注释（inCodeMode），字符串内保护", () => {
    expect(stripComments('"文本" // note', "f", 1, st(), true)).toBe('"文本" ');
    expect(stripComments("} // note", "f", 1, st(), true)).toBe("} ");
    expect(stripComments('"文本 // 内容"', "f", 1, st(), true)).toBe('"文本 // 内容"');
  });
});
