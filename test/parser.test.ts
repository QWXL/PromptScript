import { describe, test, expect } from "vitest";
import { parseDocument, resolveIncludes, resolveIncludePath } from "../src/parser.js";
import { PromptScriptError } from "../src/errors.js";

const err = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as PromptScriptError).code).toBe(code); return; }
  throw new Error(`期望抛出 ${code} 但没抛`);
};

const files = (map: Record<string, string>) => async (p: string) => map[p] ?? (() => { throw new Error(`missing ${p}`); })();

describe("文章/代码模式", () => {
  test("顶层原文行保留（含缩进），空行输出", () => {
    const d = parseDocument("  你好 {user.vip}\n\n尾行", "a.ps");
    expect(d.lines.map((l) => l.type)).toEqual(["raw", "blank", "raw"]);
    expect((d.lines[0] as { parts: unknown }).parts).toEqual(["  你好 ", { kind: "path", name: "user.vip" }]);
  });

  test("块内：字符串字面量行 + 插值；空行跳过；缩进不进入内容", () => {
    const d = parseDocument(
      '@if(ok) {\n  "a{env.weather | 未知}b"\n\n  "b"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; ifLines: { parts: unknown }[] };
    expect(b.type).toBe("block");
    expect(b.ifLines.map((l) => l.type)).toEqual(["literal", "literal"]);
    expect(b.ifLines[0].parts).toEqual(["a", { kind: "coalesce", left: { kind: "path", name: "env.weather" }, right: { kind: "literal", value: "未知" } }, "b"]);
  });

  test("else 分支 + 嵌套 if", () => {
    const d = parseDocument(
      '@if(a) {\n  @if(b) {\n    "x"\n  }\n  @else {\n    "y"\n  }\n}\n@else {\n  "z"\n}\n', "a.ps");
    const outer = d.lines[0] as { type: "block"; ifLines: unknown[]; elseLines: unknown[] };
    expect(outer.ifLines[0].type).toBe("block");
    expect(outer.elseLines.length).toBe(1);
    expect(d.lines.length).toBe(1);
  });
});

describe("块配对错误", () => {
  test("未闭合 → E_BLOCK_UNCLOSED", () => {
    err(() => parseDocument("@if(a) {\n\"x\"\n", "a.ps"), "E_BLOCK_UNCLOSED");
  });
  test("孤立 } → E_BLOCK_STRAY", () => {
    err(() => parseDocument("}\n", "a.ps"), "E_BLOCK_STRAY");
  });
  test("@else 无 if → E_ELSE_ORPHAN", () => {
    err(() => parseDocument("@else {\n}\n", "a.ps"), "E_ELSE_ORPHAN");
  });
  test("第二个 @else（前一个已附着）→ E_ELSE_ORPHAN", () => {
    err(() => parseDocument("@if(a) {\n}\n@else {\n}\n@else {\n}\n", "a.ps"), "E_ELSE_ORPHAN");
  });
  test("@if 缺 { → E_IF_EXPECT_BRACE", () => {
    err(() => parseDocument("@if(a)\n", "a.ps"), "E_IF_EXPECT_BRACE");
  });
  test("@else 缺 { → E_ELSE_EXPECT_BRACE", () => {
    err(() => parseDocument("@if(a) {\n}\n@else\n", "a.ps"), "E_ELSE_EXPECT_BRACE");
  });
});

describe("@set 静态规则", () => {
  test("顶层声明 + 位置无关引用合法", () => {
    const d = parseDocument('@set tone = "x"\n@set b = tone == "x" ? "y" : "z"\n', "a.ps");
    expect(d.decls.map((x) => x.name)).toEqual(["tone", "b"]);
  });

  test("块内 @set → E_SET_IN_BLOCK", () => {
    err(() => parseDocument('@if(a) {\n  @set x = "1"\n}\n', "a.ps"), "E_SET_IN_BLOCK");
  });

  test("同帧重名 → E_DUP_DECL", () => {
    err(() => parseDocument('@set a = "1"\n@set a = "2"\n', "a.ps"), "E_DUP_DECL");
  });

  test("TDZ：引用其后声明 → E_TDZ", () => {
    err(() => parseDocument('@set a = b\n@set b = "1"\n', "a.ps"), "E_TDZ");
  });

  test("| 回退在 @set 中合法（统一语法）", () => {
    const d = parseDocument("@set x = a | 未知\n", "a.ps");
    expect(d.decls[0]!.expr).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "未知" },
    });
  });

  test("| 回退在 @if 中合法（括号包裹路径）", () => {
    const d = parseDocument('@if(a | 未知) {\n  "x"\n}\n', "a.ps");
    expect((d.lines[0] as { type: "block"; cond: unknown }).cond).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "未知" },
    });
  });

  test("?? 括号链在 @set 中合法（统一语法）", () => {
    const d = parseDocument("@set x = a ?? (b ?? c)\n", "a.ps");
    expect(d.decls[0]!.expr).toEqual({
      kind: "coalesce",
      left: { kind: "path", name: "a" },
      right: { kind: "coalesce", left: { kind: "path", name: "b" }, right: { kind: "path", name: "c" } },
    });
  });
});

describe("@include 与 resolve", () => {
  test("resolve 递归 + dedent", async () => {
    const map = {
      "/root/a.ps": '@include("sub/b.ps")\n顶层\n',
      "/root/sub/b.ps": "  b1\n  b2\n",
    };
    const d = parseDocument(map["/root/a.ps"]!, "/root/a.ps");
    await resolveIncludes(d, files(map));
    const inc = d.lines[0] as { type: "include"; doc: { lines: { parts: unknown }[] } };
    expect(inc.doc.lines.map((l) => l.type)).toEqual(["raw", "raw"]);
    expect(inc.doc.lines[0].parts).toEqual(["b1"]);
    expect(inc.doc.parent).toBe(d);
  });

  test("缺文件 → E_INCLUDE_MISSING", async () => {
    const d = parseDocument('@include("nope.ps")\n', "/root/a.ps");
    await expect(resolveIncludes(d, files({}))).rejects.toMatchObject({ code: "E_INCLUDE_MISSING" });
  });

  test("循环 → E_INCLUDE_CYCLE", async () => {
    const map = {
      "/root/a.ps": '@include("b.ps")\n',
      "/root/b.ps": '@include("a.ps")\n',
    };
    const d = parseDocument(map["/root/a.ps"]!, "/root/a.ps");
    await expect(resolveIncludes(d, files(map))).rejects.toMatchObject({ code: "E_INCLUDE_CYCLE" });
  });

  test("匿名文档相对 include → E_SYNTAX", async () => {
    const d = parseDocument('@include("x.ps")\n', "");
    await expect(resolveIncludes(d, files({ "/x.ps": "" }))).rejects.toMatchObject({ code: "E_SYNTAX" });
  });

  test("win32 父路径的反斜杠归一化（双平台确定性）", () => {
    expect(resolveIncludePath("C:\\dir\\main.ps", "sub/x.ps")).toBe("C:/dir/sub/x.ps");
    // 偏差注：review 处方原断言为 "C:/dir/x.ps"，实际 ../x.ps 应从 C:/dir 升一级到 C:/ 根（C:/x.ps），
    // 处方值系未归一化的中间串；已按实际（= 双平台确定）语义修正断言。
    expect(resolveIncludePath("C:\\dir\\main.ps", "../x.ps")).toBe("C:/x.ps");
    // 盘符根文件（C:\main.ps，dirname 为 "C:"）与 POSIX 绝对 target 的回归护栏
    expect(resolveIncludePath("C:\\main.ps", "sub/x.ps")).toBe("C:/sub/x.ps");
    expect(resolveIncludePath("/root/a.ps", "sub/b.ps")).toBe("/root/sub/b.ps");
    expect(resolveIncludePath("C:\\dir\\main.ps", "/abs/x.ps")).toBe("/abs/x.ps");
  });

  test('@include 引号内未转义引号 → E_EXPR（带 file）', () => {
    try { parseDocument('@include("a"b.ps")', "t.ps"); } catch (e) {
      expect((e as PromptScriptError).code).toBe("E_EXPR");
      expect((e as PromptScriptError).file).toBe("t.ps");
      return;
    }
    throw new Error("期望抛出 E_EXPR");
  });
});

describe("错误 file 补全", () => {
  test("lexer 层错误带文档 file", () => {
    err(() => parseDocument("     @end\n", "sub/b.ps"), "E_UNKNOWN_DIRECTIVE");
    try { parseDocument("     @end\n", "sub/b.ps"); } catch (e) {
      expect((e as PromptScriptError).file).toBe("sub/b.ps");
    }
  });
});

describe("C 风格注释", () => {
  test("文章模式整行注释不产生节点", () => {
    const d = parseDocument("段落一\n// 注释\n段落二", "a.ps");
    expect(d.lines.map((l) => l.type)).toEqual(["raw", "raw"]);
  });

  test("跨行块注释整体擦除（含中间行）", () => {
    const d = parseDocument("前\n/*\n中间\n*/\n后", "a.ps");
    expect(d.lines.map((l) => l.type)).toEqual(["raw", "raw"]);
  });

  test("指令行尾部注释剥离后正常解析", () => {
    const d = parseDocument("@set x = a // 说明\n", "a.ps");
    expect(d.decls[0]!.expr).toEqual({ kind: "path", name: "a" });
  });

  test("@if 条件行与 } 闭合行尾部注释", () => {
    const d = parseDocument('@if(a) { // 条件\n  "x"\n} // 闭合\n', "a.ps");
    expect(d.lines.length).toBe(1);
    expect((d.lines[0] as { cond: unknown }).cond).toEqual({ kind: "path", name: "a" });
  });

  test("代码模式注释行不触发 E_EXPECT_STRING", () => {
    const d = parseDocument('@if(ok) {\n  // 注释\n  "x"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; ifLines: { type: string }[] };
    expect(b.ifLines.map((l) => l.type)).toEqual(["literal"]);
  });

  test("未闭合块注释 → E_COMMENT_UNCLOSED（块起始行号）", () => {
    try { parseDocument("正文\n/* 开了\n内容\n", "a.ps"); } catch (e) {
      expect((e as PromptScriptError).code).toBe("E_COMMENT_UNCLOSED");
      expect((e as PromptScriptError).line).toBe(2);
      return;
    }
    throw new Error("期望抛出 E_COMMENT_UNCLOSED");
  });

  test("行首孤立 */ → E_COMMENT_STRAY", () => {
    err(() => parseDocument("*/ x\n", "a.ps"), "E_COMMENT_STRAY");
  });

  test("槽位内注释维持 E_EXPR（表达式层不支持）", () => {
    err(() => parseDocument("{a // b}\n", "a.ps"), "E_EXPR");
  });

  test("指令行行内 /* 未闭合 → 跨行块 → EOF E_COMMENT_UNCLOSED（开块行号）", () => {
    try { parseDocument("@set x = a /* 说明\n内容\n", "a.ps"); } catch (e) {
      expect((e as PromptScriptError).code).toBe("E_COMMENT_UNCLOSED");
      expect((e as PromptScriptError).line).toBe(1);
      return;
    }
    throw new Error("期望抛出 E_COMMENT_UNCLOSED");
  });
});

describe("@for 解析", () => {
  test("三种形式 → for 节点", () => {
    const d = parseDocument('@for v in tags {\n  "{v}"\n}\n', "a.ps");
    const f = d.lines[0] as { type: "for"; vars: string[]; iterable: unknown; body: { type: string }[]; elseLines: null };
    expect(f.type).toBe("for");
    expect(f.vars).toEqual(["v"]);
    expect(f.iterable).toEqual({ kind: "expr", expr: { kind: "path", name: "tags" } });
    expect(f.body.map((l) => l.type)).toEqual(["literal"]);
    expect(f.elseLines).toBeNull();

    const d2 = parseDocument('@for k, v in tags {\n  "{k}={v}"\n}\n', "a.ps");
    expect((d2.lines[0] as { type: "for"; vars: string[] }).vars).toEqual(["k", "v"]);

    const d3 = parseDocument('@for i in 1..5 {\n  "{i}"\n}\n', "a.ps");
    expect((d3.lines[0] as { type: "for"; iterable: unknown }).iterable).toEqual({ kind: "range", from: 1, to: 5 });
  });

  test("@for + @else 附着；循环体内 @else 附着内层 @if", () => {
    const d = parseDocument('@for v in tags {\n  @if(v) {\n    "x"\n  }\n  @else {\n    "y"\n  }\n}\n@else {\n  "空"\n}\n', "a.ps");
    const f = d.lines[0] as { type: "for"; body: unknown[]; elseLines: unknown[] };
    expect(f.type).toBe("for");
    expect(f.body.length).toBe(1);
    expect(f.elseLines).toHaveLength(1);
    expect(d.lines.length).toBe(1);
  });

  test("循环体内 @set → E_SET_IN_BLOCK", () => {
    err(() => parseDocument('@for v in tags {\n  @set x = "1"\n}\n', "a.ps"), "E_SET_IN_BLOCK");
  });

  test("未闭合 → E_BLOCK_UNCLOSED；缺 { → E_FOR_EXPECT_BRACE", () => {
    err(() => parseDocument('@for v in tags {\n"x"\n', "a.ps"), "E_BLOCK_UNCLOSED");
    err(() => parseDocument("@for v in tags\n", "a.ps"), "E_FOR_EXPECT_BRACE");
  });

  test("格式错误 → E_FOR_FORMAT", () => {
    err(() => parseDocument('@for in tags {\n  "x"\n}\n', "a.ps"), "E_FOR_FORMAT");
    err(() => parseDocument('@for a, b, c in tags {\n  "x"\n}\n', "a.ps"), "E_FOR_FORMAT");
    err(() => parseDocument("@for v {\n", "a.ps"), "E_FOR_FORMAT");
    err(() => parseDocument('@for v..x in tags {\n  "x"\n}\n', "a.ps"), "E_FOR_FORMAT");
  });

  test("范围边界非法 → E_FOR_RANGE；范围双变量 → E_FOR_FORMAT", () => {
    err(() => parseDocument('@for i in 1..3.5 {\n  "x"\n}\n', "a.ps"), "E_FOR_RANGE");
    err(() => parseDocument('@for i in a..b {\n  "x"\n}\n', "a.ps"), "E_FOR_RANGE");
    err(() => parseDocument('@for i in -1..5 {\n  "x"\n}\n', "a.ps"), "E_FOR_RANGE");
    err(() => parseDocument('@for i, j in 1..5 {\n  "x"\n}\n', "a.ps"), "E_FOR_FORMAT");
  });

  test("记录键名含 in 不误切；@for 在 @if 块内合法", () => {
    const d = parseDocument('@for v in {"in": 1} {\n  "{v}"\n}\n', "a.ps");
    expect((d.lines[0] as { type: "for"; iterable: { kind: string } }).iterable.kind).toBe("expr");
    const d2 = parseDocument('@if(ok) {\n  @for v in tags {\n    "{v}"\n  }\n}\n', "a.ps");
    expect((d2.lines[0] as { type: "block"; ifLines: { type: string }[] }).ifLines[0].type).toBe("for");
  });

  test("循环内 @include 被 collectIncludes 收集", async () => {
    const map = { "/root/a.ps": '@for v in tags {\n  @include("b.ps")\n}\n', "/root/b.ps": "b1\n" };
    const d = parseDocument(map["/root/a.ps"]!, "/root/a.ps");
    await resolveIncludes(d, files(map));
    const f = d.lines[0] as { type: "for"; body: { type: string; doc: unknown }[] };
    expect(f.body[0].type).toBe("include");
    expect(f.body[0].doc).not.toBeNull();
  });
});

describe("同行连接：} @else 与 else-if 链", () => {
  test("} @else { 与两行等价：单节点 + elseLines", () => {
    const d = parseDocument('@if(a) {\n  "x"\n} @else {\n  "y"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; ifLines: unknown[]; elseLines: unknown[] };
    expect(b.type).toBe("block");
    expect(b.ifLines.length).toBe(1);
    expect(b.elseLines.length).toBe(1);
    expect(d.lines.length).toBe(1);
  });

  test("else-if 链：else 分支含 block 节点（与手写嵌套 AST 一致）", () => {
    const d = parseDocument('@if(a) {\n  "甲"\n} @else @if(b) {\n  "乙"\n} @else {\n  "丙"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; elseLines: { type: string; cond: unknown; elseLines: unknown[] }[] };
    expect(b.elseLines).toHaveLength(1);
    const e = b.elseLines[0]!;
    expect(e.type).toBe("block");
    expect(e.cond).toEqual({ kind: "path", name: "b" });
    expect(e.elseLines).toHaveLength(1);   // 链尾 @else 附着在 b 块上
  });

  test("@else @if 独立行（无同行 }）", () => {
    const d = parseDocument('@if(a) {\n  "x"\n}\n@else @if(b) {\n  "y"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; elseLines: { type: string }[] };
    expect(b.elseLines[0]!.type).toBe("block");
  });

  test("@for 后同行 else + else-if 链", () => {
    const d = parseDocument('@for v in tags {\n  "{v}"\n} @else @if(flag) {\n  "空"\n} @else {\n  "无"\n}\n', "a.ps");
    const f = d.lines[0] as { type: "for"; elseLines: { type: string }[] };
    expect(f.type).toBe("for");
    expect(f.elseLines[0]!.type).toBe("block");
  });

  test("错误路径", () => {
    err(() => parseDocument('@if(a) {\n  "x"\n} @else\n', "a.ps"), "E_ELSE_EXPECT_BRACE");          // 缺 {
    err(() => parseDocument("} @else {\n", "a.ps"), "E_BLOCK_STRAY");                                // 无块
    // 偏差注：brief 原文两个 `} @else {` 之间多一个独立 `}`——第一个 else 分支被它提前闭合后，
    // 第二个 `} @else {` 的 `}` 无块可闭 → 实际抛 E_BLOCK_STRAY（规格 §3.5「前无未闭合块 → E_BLOCK_STRAY」）。
    // 规格 §5 钉住「双 else → E_ELSE_ORPHAN」：去掉该独立 `}`，让第二个 `}` 闭合首个 else 分支、
    // 随后 @else 撞上已附着的 else → E_ELSE_ORPHAN（E_BLOCK_STRAY 场景已由本测试上一行覆盖）。
    err(() => parseDocument('@if(a) {\n  "x"\n} @else {\n  "y"\n} @else {\n  "z"\n}\n', "a.ps"), "E_ELSE_ORPHAN"); // 双 else
    err(() => parseDocument('@if(a) {\n  "x"\n} @else @if(b) {', "a.ps"), "E_BLOCK_UNCLOSED");       // 链未闭合
    err(() => parseDocument('@if(a) {\n  "x"\n} @else @if(b)\n', "a.ps"), "E_IF_EXPECT_BRACE");       // 链缺 {
  });
});
