import { describe, test, expect } from "vitest";
import { parseExpr, parseLiteralValue } from "../src/expr.js";
import type { Expr } from "../src/ast.js";
import { PromptScriptError } from "../src/errors.js";

const err = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as PromptScriptError).code).toBe(code); return; }
  throw new Error(`期望抛出 ${code} 但没抛`);
};

describe("槽位顶层形态", () => {
  test("裸路径", () => {
    expect(parseExpr("user.vip", "f", 1)).toEqual({ kind: "path", name: "user.vip" });
  });

  test("?? 链 + 自动识别：路径形右 → path", () => {
    expect(parseExpr("a ?? b.c", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "path", name: "b.c" },
    });
  });

  test("?? 自动识别：引号 → 字符串字面量；数字 → number；无法分类 → 表达式", () => {
    expect(parseExpr('a ?? "未知"', "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "未知" },
    });
    expect(parseExpr("a ?? 5", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: 5 },
    });
    expect(parseExpr("a ?? b && c", "f", 1)).toEqual({
      kind: "coalesce",
      left: { kind: "path", name: "a" },
      right: { kind: "logical", op: "&&", left: { kind: "path", name: "b" }, right: { kind: "path", name: "c" } },
    });
  });

  test("?? 链左结合", () => {
    const e = parseExpr("a ?? b ?? c", "f", 1);
    expect(e).toEqual({
      kind: "coalesce",
      left: { kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "path", name: "b" } },
      right: { kind: "path", name: "c" },
    });
  });

  test("| 纯字面回退", () => {
    expect(parseExpr("a | 晴", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "晴" },
    });
    expect(parseExpr("a | 晴到多云 最高30度", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "晴到多云 最高30度" },
    });
  });

  test("| 回退在括号包裹下同样生效（@if 强制括号路径）", () => {
    expect(parseExpr("(a | 未知)", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "未知" },
    });
  });

  test("| 右侧为原文：嵌套回退 (x | y) | z", () => {
    expect(parseExpr("(x | y) | z", "f", 1)).toEqual({
      kind: "coalesce",
      left: { kind: "coalesce", left: { kind: "path", name: "x" }, right: { kind: "literal", value: "y" } },
      right: { kind: "literal", value: "z" },
    });
    // | 之后 ?? 不解析，整段是字面文本
    expect(parseExpr("a | b ?? c", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "b ?? c" },
    });
  });

  test("| 与 ?? 可结合：a ?? b | 回退", () => {
    expect(parseExpr("a ?? b | 回退", "f", 1)).toEqual({
      kind: "coalesce",
      left: { kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "path", name: "b" } },
      right: { kind: "literal", value: "回退" },
    });
  });

  test("|| 一律是逻辑或（?? 别名已移除）", () => {
    expect(parseExpr("a || b.c", "f", 1)).toEqual({
      kind: "logical", op: "||",
      left: { kind: "path", name: "a" }, right: { kind: "path", name: "b.c" },
    });
    expect(parseExpr("a || b && c", "f", 1)).toEqual({
      kind: "logical", op: "||",
      left: { kind: "path", name: "a" },
      right: { kind: "logical", op: "&&", left: { kind: "path", name: "b" }, right: { kind: "path", name: "c" } },
    });
  });

  test("?? 右侧括号表达式 → 连锁", () => {
    expect(parseExpr("a ?? (b ?? c)", "f", 1)).toEqual({
      kind: "coalesce",
      left: { kind: "path", name: "a" },
      right: { kind: "coalesce", left: { kind: "path", name: "b" }, right: { kind: "path", name: "c" } },
    });
  });

  test("槽内三元", () => {
    expect(parseExpr('user.vip == "svip" ? "尊贵" : ""', "f", 1)).toEqual({
      kind: "cond",
      test: { kind: "compare", op: "==", left: { kind: "path", name: "user.vip" }, right: { kind: "literal", value: "svip" } },
      yes: { kind: "literal", value: "尊贵" },
      no: { kind: "literal", value: "" },
    });
  });

  test("槽内记录下标：vip_label[user.vip]", () => {
    expect(parseExpr("vip_label[user.vip]", "f", 1)).toEqual({
      kind: "index", obj: { kind: "path", name: "vip_label" }, index: { kind: "path", name: "user.vip" },
    });
  });

  test("槽内完整逻辑表达式", () => {
    expect(parseExpr("a && !b || c", "f", 1)).toEqual({
      kind: "logical", op: "||",
      left: { kind: "logical", op: "&&", left: { kind: "path", name: "a" }, right: { kind: "not", operand: { kind: "path", name: "b" } } },
      right: { kind: "path", name: "c" },
    });
  });
});

describe("通用表达式（@set/@if 同一语法）", () => {
  test("比较链", () => {
    expect(parseExpr("a.b > 30 && c != null", "f", 1)).toEqual({
      kind: "logical", op: "&&",
      left: { kind: "compare", op: ">", left: { kind: "path", name: "a.b" }, right: { kind: "literal", value: 30 } },
      right: { kind: "compare", op: "!=", left: { kind: "path", name: "c" }, right: { kind: "literal", value: null } },
    });
  });

  test("?? 右侧任意表达式（括号/比较链与槽位一致）", () => {
    expect(parseExpr("x ?? y", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "x" }, right: { kind: "path", name: "y" },
    });
    expect(parseExpr("x ?? y == 1", "f", 1)).toEqual({
      kind: "coalesce",
      left: { kind: "path", name: "x" },
      right: { kind: "compare", op: "==", left: { kind: "path", name: "y" }, right: { kind: "literal", value: 1 } },
    });
    expect(parseExpr("x ?? (y ?? z)", "f", 1)).toEqual({
      kind: "coalesce",
      left: { kind: "path", name: "x" },
      right: { kind: "coalesce", left: { kind: "path", name: "y" }, right: { kind: "path", name: "z" } },
    });
  });

  test("?? 尾空右段 → E_EXPR（统一后不再静默空串回退）", () => {
    err(() => parseExpr("a ??", "f", 1), "E_EXPR");
  });

  test("三元右结合", () => {
    const e = parseExpr("a ? b ? c : d : e", "f", 1);
    expect(e.kind).toBe("cond");
    const inner = (e as { yes: Expr }).yes;
    expect(inner).toEqual({
      kind: "cond", test: { kind: "path", name: "b" }, yes: { kind: "path", name: "c" }, no: { kind: "path", name: "d" },
    });
  });

  test("括号分组", () => {
    expect(parseExpr("!(a && b)", "f", 1)).toEqual({
      kind: "not",
      operand: { kind: "logical", op: "&&", left: { kind: "path", name: "a" }, right: { kind: "path", name: "b" } },
    });
  });
});

describe("记录字面量", () => {
  test("键：裸标识符/引号/数字，值仅字面量", () => {
    expect(parseExpr('{"svip": "超级会员", 0: "免费", 普通: "普通会员"}', "f", 1)).toEqual({
      kind: "record",
      entries: [
        ["svip", "超级会员"], ["0", "免费"], ["普通", "普通会员"],
      ],
    });
  });

  test("值非字面量 → E_EXPR", () => {
    err(() => parseExpr("{a: b}", "f", 1), "E_EXPR");
  });

  test("空记录合法", () => {
    expect(parseExpr("{}", "f", 1)).toEqual({ kind: "record", entries: [] });
  });
});

describe("字面量值（| 回退等）", () => {
  test("parseLiteralValue：引号/数字/bool/null/原文案", () => {
    expect(parseLiteralValue('"x"', "f", 1)).toBe("x");
    expect(parseLiteralValue("3.5", "f", 1)).toBe(3.5);
    expect(parseLiteralValue("true", "f", 1)).toBe(true);
    expect(parseLiteralValue("null", "f", 1)).toBe(null);
    expect(parseLiteralValue("晴到多云", "f", 1)).toBe("晴到多云");
  });

  test("| 回退未加引号文本：\\\\ 解码为 \\（永远转义）；其余 \\x 原样保留", () => {
    // 源码 a\\b（两个反斜杠）→ 字面量 a\b（一个反斜杠）
    expect(parseExpr("a | x\\\\y", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "x\\y" },
    });
    // 单个反斜杠 + 普通字符（如 \b）→ 原样保留
    expect(parseExpr("a | x\\y", "f", 1)).toEqual({
      kind: "coalesce", left: { kind: "path", name: "a" }, right: { kind: "literal", value: "x\\y" },
    });
  });
});

describe("语法错误", () => {
  test("坏 token / 不完整 → E_EXPR", () => {
    err(() => parseExpr("a b", "f", 1), "E_EXPR");
    err(() => parseExpr("a ? b", "f", 1), "E_EXPR");
    err(() => parseExpr("{a: 1,}", "f", 1), "E_EXPR");
  });

  test("?? 右侧无法解析为表达式 → E_EXPR（不再静默当文本）", () => {
    err(() => parseExpr("a ?? 晴到多云 最高30度", "f", 1), "E_EXPR");
  });
});
