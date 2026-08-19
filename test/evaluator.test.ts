import { describe, test, expect } from "vitest";
import { parseDocument, resolveIncludes } from "../src/parser.js";
import { renderDocument, collectMissing } from "../src/evaluator.js";

const R = async (text: string, values: Record<string, unknown> = {}, fs: Record<string, string> = {}) => {
  const d = parseDocument(text, "t.ps");
  await resolveIncludes(d, async (p) => {
    if (p in fs) return fs[p];
    throw new Error(`missing ${p}`);
  });
  return renderDocument(d, values as never);
};

const err = async (fn: () => Promise<unknown> | unknown, code: string) => {
  try { await fn(); } catch (e) { expect((e as { code: string }).code).toBe(code); return; }
  throw new Error(`期望抛出 ${code} 但没抛`);
};

describe("基本渲染", () => {
  test("插值 + 原文行 + 空行结构", async () => {
    expect(await R("你好 {user.vip}\n\n尾行 {a}", { "user.vip": "svip", a: "X" })).toBe("你好 svip\n\n尾行 X");
  });

  test("槽位回退：?? 引号 / | 字面 / 软空缺空串", async () => {
    // 偏差注：brief 原文注入 { b: "实际" } 且槽位含未绑定 {c}——与期望 "缺 晴 "（b 必须未绑定走 | 回退）
    // 及空缺矩阵（未绑定槽位 → E_UNBOUND）双重矛盾；改为 { c: undefined }：
    // a 未绑定 → ?? 回退；b 未绑定 → | 回退；c 软空缺（显式 undefined）→ 空串。期望串保持 brief 原值。
    expect(await R("{a ?? \"缺\"} {b | 晴} {c}", { c: undefined })).toBe("缺 晴 ");
    // 偏差注：brief 原文 { a: undefined } 期望 ""——但 ?? 右侧 b 未绑定属硬空缺（"右 MISS 继续上抛"），
    // 按 brief 自身语义应 E_UNBOUND；把右侧也注入为软空缺 → ""（保住原期望）。
    expect(await R("{a ?? b}", { a: undefined, b: undefined })).toBe("");
    // 回退右侧为硬空缺（未绑定）→ E_UNBOUND 上抛（规范 3.1：未绑定 + 实际渲染 → 硬空缺）
    await err(() => R("{a ?? b}", { a: undefined }), "E_UNBOUND");
  });

  test("| 回退右侧未加引号文本中的 \\\\ 解码为 \\（与规范一致）", async () => {
    // 源码 a\\b（两个反斜杠）→ 渲染 a\b（一个反斜杠）
    expect(await R("{b | a\\\\b}")).toBe("a\\b");
    // \\} 转义仍生效：a\}b → a}b
    expect(await R("{b | a\\}b}")).toBe("a}b");
  });

  test("?? 右侧连锁：未绑定 → 求值复杂表达式", async () => {
    expect(await R('{x ?? (b ? "是" : "否")}', { b: true })).toBe("是");
    expect(await R('{x ?? (b ? "是" : "否")}', { b: false })).toBe("否");
  });

  test("三元 + 记录下标", async () => {
    const text = '@set v = {"svip": "超级", 0: "免费"}\n{v[user.vip] ?? "未知"}';
    expect(await R(text, { "user.vip": "svip" })).toBe("超级");
    expect(await R(text, { "user.vip": 0 })).toBe("免费");
    expect(await R(text, {})).toBe("未知");
  });

  test("@if 花括号块（代码模式字符串行）", async () => {
    const text = '@if(ok) {\n  "是{env.weather | 未知}"\n}\n@else {\n  "否"\n}\n尾行';
    expect(await R(text, { ok: true, "env.weather": "晴" })).toBe("是晴\n尾行");
    expect(await R(text, { ok: false })).toBe("否\n尾行");
  });

  test("嵌套 @if", async () => {
    const text = '@if(a) {\n  @if(b) {\n    "AB"\n  }\n  @else {\n    "A"\n  }\n}\n@else {\n  "X"\n}\n';
    expect(await R(text, { a: true, b: true })).toBe("AB");
    expect(await R(text, { a: true, b: false })).toBe("A");
    expect(await R(text, { a: false })).toBe("X");
  });

  test("注释行不渲染、不产生空行；跨行块注释整体擦除", async () => {
    expect(await R("段落一\n// 注释\n段落二")).toBe("段落一\n段落二");
    expect(await R("前\n/*\n中间\n*/\n后")).toBe("前\n后");
  });

  test("原文行中间 // 原样渲染；\\// 转义输出字面 //", async () => {
    expect(await R("访问 http://a//b")).toBe("访问 http://a//b");
    expect(await R("\\// 代码注释")).toBe("// 代码注释");
  });
});

describe("空缺矩阵", () => {
  test("硬空缺：裸引用未绑定 → E_UNBOUND（带行号）", async () => {
    await err(() => R("第一行\n{no_such_field}"), "E_UNBOUND");
  });

  test("假分支内的未绑定名无影响", async () => {
    expect(await R('@if(ok) {\n  "{missing}"\n}\n', { ok: false })).toBe("");
  });

  test("软空缺：undefined/null 渲染空串不报错", async () => {
    expect(await R("{a}{b}", { a: undefined, b: null })).toBe("");
  });

  test("@set 引用未绑定 → E_UNBOUND", async () => {
    await err(() => R('@set x = missing_name\n{x}'), "E_UNBOUND");
  });

  test("谓词未绑定 → E_UNBOUND", async () => {
    await err(() => R('@if(missing) {\n  "x"\n}\n'), "E_UNBOUND");
  });

  test("直接渲染记录 → E_RECORD_RENDER", async () => {
    await err(() => R('@set r = {"a": 1}\n{r}'), "E_RECORD_RENDER");
  });

  test("注入名与根帧 @set 冲突 → E_INJECT_CONFLICT", async () => {
    await err(() => R('@set x = "1"\n{x}', { x: "2" }), "E_INJECT_CONFLICT");
  });

  test("@set 未绑定名帧求值即爆：未被引用也报错", async () => {
    await err(() => R('@set x = missing_name\n好', {}), "E_UNBOUND");
  });

  test("@set 带 ?? 救援不误报：coalesce 先于帧求值检查兜底", async () => {
    expect(await R('@set x = a ?? "d"\n{x}', {})).toBe("d");
  });

  test("比较操作数未绑定 → E_UNBOUND（硬空缺，不再空值等价/静默 false）", async () => {
    await err(() => R('{a < b}', { b: 1 }), "E_UNBOUND");
    await err(() => R('@if(a == 1) {\n  "x"\n}\n', {}), "E_UNBOUND");
  });

  test("原型链不穿透：继承成员不可访问", async () => {
    await err(() => R("{r.constructor}", { r: {} }), "E_UNBOUND");
    await err(() => R('{r["toString"]}', { r: {} }), "E_UNBOUND");
  });

  test("自有函数值 → E_RECORD_RENDER", async () => {
    await err(() => R("{r.handler}", { r: { handler: () => 42 } }), "E_RECORD_RENDER");
  });

  test("|| 左 MISS → E_UNBOUND（与 && 对齐）", async () => {
    await err(() => R('@if(a || b) {\n  "x"\n}\n', { b: true }), "E_UNBOUND");
  });
});

describe("include 子帧", () => {
  test("子帧可见父绑定 + 遮蔽 + 双 include 独立", async () => {
    const fs = {
      "/t/child.ps": '子见父{parent_var} 遮蔽{shared}\n',
    };
    const text = '@set parent_var = "P"\n@set shared = "root"\n@include("child.ps")\n顶层{shared}';
    const d = parseDocument(text, "/t/main.ps");
    await resolveIncludes(d, async (p) => fs[p] ?? (() => { throw new Error("x"); })());
    expect(renderDocument(d, {})).toBe("子见父P 遮蔽root\n顶层root");

    const text2 = '@set shared = "root"\n@include("child2.ps")',
      fs2 = { "/t/child2.ps": '@set shared = "child"\n遮蔽{shared}\n' };
    const d2 = parseDocument(text2, "/t/main.ps");
    await resolveIncludes(d2, async (p) => fs2[p] ?? (() => { throw new Error("x"); })());
    expect(renderDocument(d2, {})).toBe("遮蔽child");
  });

  test("include 子文件顶层空行输出空行", async () => {
    const fs = { "/t/b.ps": "x\n\ny\n" };
    const d = parseDocument('@include("b.ps")', "/t/main.ps");
    await resolveIncludes(d, async (p) => fs[p] ?? "");
    expect(renderDocument(d, {})).toBe("x\n\ny");
  });

  test("未 resolve 的 include → E_UNRESOLVED", async () => {
    const d = parseDocument('@include("b.ps")', "/t/main.ps");
    expect(() => renderDocument(d, {})).toThrow();
    try { renderDocument(d, {}); } catch (e) { expect((e as { code: string }).code).toBe("E_UNRESOLVED"); }
  });

  test("include 在假分支 → 不求值不渲染", async () => {
    const fs = { "/t/b.ps": '引用未绑定名 {zzz}\n' };
    const d = parseDocument('@if(ok) {\n  @include("b.ps")\n}\n', "/t/main.ps");
    await resolveIncludes(d, async (p) => fs[p] ?? "");
    expect(renderDocument(d, { ok: false })).toBe("");
  });
});

describe("比较与逻辑", () => {
  test("== != 与空值等价", async () => {
    expect(await R('{a == null ? "空" : "有"}', { a: undefined })).toBe("空");
    expect(await R('{a != null ? "有" : "空"}', { a: "x" })).toBe("有");
  });

  test("< > 仅数字；否则 E_TYPE", async () => {
    expect(await R('@if(score > 30) {\n  "高"\n}\n', { score: 60 })).toBe("高");
    await err(() => R('{a < b}', { a: "x", b: 1 }), "E_TYPE");
  });

  test("逻辑短路 && ||", async () => {
    expect(await R('@if(a && b) {\n  "Y"\n}\n', { a: false })).toBe("");
  });

  test("coalesce 只对 null/undefined/MISS 兜底，空串/0 不算", async () => {
    expect(await R('{a ?? "缺"}', { a: "" })).toBe("");
    expect(await R('{a ?? "缺"}', { a: 0 })).toBe("0");
    expect(await R('{a ?? "缺"}', { a: false })).toBe("false");
  });

  test("记录 == 深比较：键序无关、嵌套记录", async () => {
    expect(await R('{a == b ? "等" : "不等"}', { a: { x: 1, y: 2 }, b: { y: 2, x: 1 } })).toBe("等");
    expect(await R('{a == b ? "等" : "不等"}', { a: { x: 1 }, b: { x: 2 } })).toBe("不等");
    expect(await R('{a == b ? "等" : "不等"}', { a: { x: { y: 1 } }, b: { x: { y: 1 } } })).toBe("等");
    expect(await R('{a == b ? "等" : "不等"}', { a: { x: { y: 1 } }, b: { x: { y: 2 } } })).toBe("不等");
  });

  test("记录 == undefined 值键参与比较（{a: undefined} ≠ {}）", async () => {
    expect(await R('{a == b ? "等" : "不等"}', { a: { x: undefined }, b: {} })).toBe("不等");
    expect(await R('{a == b ? "等" : "不等"}', { a: { x: undefined }, b: { x: undefined } })).toBe("等");
  });

  test("数组比较（注入值，运行时防御）：逐元素", async () => {
    expect(await R('{a == b ? "等" : "不等"}', { a: [1, 2], b: [1, 2] })).toBe("等");
    expect(await R('{a == b ? "等" : "不等"}', { a: [1, 2], b: [1, 3] })).toBe("不等");
  });
});

describe("collectMissing", () => {
  test("收集链上不可解析的名字（去重保序，decls 先行）", async () => {
    const d = parseDocument('@set x = y\n{a}{b.c}{a}{d}\n', "t.ps");
    expect(collectMissing(d)).toEqual(["y", "a", "b.c", "d"]);
  });

  test("@set 首段/精确名可解析的不收集；include 子文档递归（父链可解析）", async () => {
    const fs = { "/t/c.ps": "{zzz}{parent_var}\n" };
    const main = parseDocument('@set parent_var = "P"\n@set u = v\n{u}{parent_var}\n@include("c.ps")\n', "/t/main.ps");
    await resolveIncludes(main, async (p) => fs[p] ?? "");
    expect(collectMissing(main)).toEqual(["v", "zzz"]);
  });

  test("循环变量不报 missing；数据源与 else 分支照报", async () => {
    const d = parseDocument('@for v in tags {\n  "{v}{v.x}"\n}\n', "t.ps");
    expect(collectMissing(d)).toEqual(["tags"]);

    const d2 = parseDocument('@for k, v in tags {\n  "{k}{v}"\n}\n@else {\n  "{missing}"\n}\n', "t.ps");
    expect(collectMissing(d2)).toEqual(["tags", "missing"]);
  });

  test("循环变量经 include 进入子文档不误报", async () => {
    const fs = { "/t/c.ps": "{v}{zzz}\n" };
    const main = parseDocument('@for v in tags {\n  @include("c.ps")\n}\n', "/t/main.ps");
    await resolveIncludes(main, async (p) => fs[p] ?? "");
    expect(collectMissing(main)).toEqual(["tags", "zzz"]);
  });

  test("评审补充（Task 3 Minor #3）：@for 数据源未绑定被收集，循环变量不误报", async () => {
    const d = parseDocument('@for v in nope {\n  "{v}"\n}\n', "t.ps");
    expect(collectMissing(d)).toEqual(["nope"]);
  });

  test("嵌套 @for：外层循环变量在内层可见不误报，数据源照报", async () => {
    const d = parseDocument('@set v = "x"\n@for i in 1..2 {\n  @for v in tags {\n    "{v}{i}"\n  }\n}\n', "t.ps");
    expect(collectMissing(d)).toEqual(["tags"]);
  });
});

describe("@for 循环", () => {
  test("记录迭代：单变量=值，双变量=键+值；键序（数字键在前）", async () => {
    expect(await R('@for v in tags {\n  "- {v}"\n}\n', { tags: { a: "A", b: "B" } })).toBe("- A\n- B");
    expect(await R('@for k, v in tags {\n  "{k}={v}"\n}\n', { tags: { a: "A", b: "B" } })).toBe("a=A\nb=B");
    expect(await R('@for k, v in r {\n  "{k}"\n}\n', { r: { 1: "x", a: "y" } })).toBe("1\na");
    expect(await R('@set tags = {"a": "A"}\n@for v in tags {\n  "{v}"\n}\n')).toBe("A");
  });

  test("范围闭区间；空迭代走 @else", async () => {
    expect(await R('@for i in 1..3 {\n  "第 {i} 段"\n}\n')).toBe("第 1 段\n第 2 段\n第 3 段");
    expect(await R('@for i in 0..2 {\n  "{i}"\n}\n')).toBe("0\n1\n2");
    expect(await R('@for i in 1..1 {\n  "{i}"\n}\n')).toBe("1");
    expect(await R('@for v in tags {\n  "{v}"\n}\n@else {\n  "空"\n}\n', { tags: {} })).toBe("空");
    expect(await R('@for i in 5..1 {\n  "{i}"\n}\n@else {\n  "空"\n}\n')).toBe("空");
    expect(await R('@for v in tags {\n  "{v}"\n}\n@else {\n  "空"\n}\n', { tags: { a: "A" } })).toBe("A");
  });

  test("遮蔽恢复；嵌套 @for 内层遮蔽外层", async () => {
    // 偏差注：brief 原文末行为 `"{name}"` 且期望 "A\n全局"——与规范矛盾：顶层（深度 0）是文章模式，
    // 引号是字面内容，末行会渲染成 "全局"（带引号）。测试意图是"循环后遮蔽恢复"，改为无引号的
    // `{name}` 行（期望串保持 brief 原值）。
    const text = '@set name = "全局"\n@for name in tags {\n  "{name}"\n}\n{name}\n';
    expect(await R(text, { tags: { x: "A" } })).toBe("A\n全局");
    expect(await R('@for i in 1..2 {\n  @for i in 1..2 {\n    "{i}"\n  }\n}\n')).toBe("1\n2\n1\n2");
  });

  test("数据源未绑定 → E_UNBOUND；非记录 → E_TYPE", async () => {
    await err(() => R('@for v in nope {\n  "{v}"\n}\n'), "E_UNBOUND");
    await err(() => R('@for v in 42 {\n  "{v}"\n}\n'), "E_TYPE");
    await err(() => R('@for v in arr {\n  "{v}"\n}\n', { arr: [1, 2] }), "E_TYPE");
  });

  test("超 32768 → E_FOR_LIMIT（范围与记录）", async () => {
    await err(() => R('@for i in 1..32769 {\n  "{i}"\n}\n'), "E_FOR_LIMIT");
    const big: Record<string, string> = {};
    for (let i = 0; i < 32769; i++) big["k" + i] = "v";
    await err(() => R('@for v in big {\n  "{v}"\n}\n', { big }), "E_FOR_LIMIT");
  });

  test("边界恰好 32768 合法", async () => {
    const out = await R('@for i in 1..32768 {\n  "x"\n}\n');
    expect(out.split("\n")).toHaveLength(32768);
  });

  test("循环体内直接渲染记录值 → E_RECORD_RENDER", async () => {
    await err(() => R('@for v in tags {\n  "{v}"\n}\n', { tags: { a: { x: 1 } } }), "E_RECORD_RENDER");
  });

  test("rec ?? {} 空回退 idiom", async () => {
    expect(await R('@for k, v in tags ?? {} {\n  "{k}"\n}\n@else {\n  "空"\n}\n', {})).toBe("空");
    expect(await R('@for k, v in tags ?? {} {\n  "{k}"\n}\n', { tags: { a: 1 } })).toBe("a");
  });

  test("循环内 @include：引用循环变量 / 子帧 @set 遮蔽 / 空迭代不执行", async () => {
    const fs = {
      "/t/item.ps": "项：{v}\n",
      "/t/shadow.ps": '@set v = "子"\n{v}\n',
    };
    const d = parseDocument('@for v in tags {\n  @include("item.ps")\n}\n', "/t/main.ps");
    await resolveIncludes(d, async (p) => fs[p] ?? "");
    expect(renderDocument(d, { tags: { a: "A", b: "B" } })).toBe("项：A\n项：B");

    const d2 = parseDocument('@for v in tags {\n  @include("shadow.ps")\n}\n', "/t/main.ps");
    await resolveIncludes(d2, async (p) => fs[p] ?? "");
    expect(renderDocument(d2, { tags: { a: "A" } })).toBe("子");

    const d3 = parseDocument('@for v in tags {\n  @include("item.ps")\n}\n', "/t/main.ps");
    await resolveIncludes(d3, async (p) => fs[p] ?? "");
    expect(renderDocument(d3, { tags: {} })).toBe("");
  });

  test("@for 在 @if 块内（真/假分支）", async () => {
    const text = '@if(ok) {\n  @for v in tags {\n    "{v}"\n  }\n}\n';
    expect(await R(text, { ok: true, tags: { a: "A" } })).toBe("A");
    expect(await R(text, { ok: false, tags: { a: "A" } })).toBe("");
  });

  test("空迭代 @else 在外层帧渲染：外层绑定可见、循环变量不可见", async () => {
    expect(await R('@for v in tags {\n  "{v}"\n}\n@else {\n  "{outer}"\n}\n', { tags: {}, outer: "外层" })).toBe("外层");
    await err(() => R('@for v in tags {\n  "{v}"\n}\n@else {\n  "{v}"\n}\n', { tags: {} }), "E_UNBOUND");
  });
});

describe("同行连接与 else-if 链", () => {
  test("三链渲染：a 真 → 甲；b 真 → 乙；否则 → 丙", async () => {
    const text = '@if(a) {\n  "甲"\n} @else @if(b) {\n  "乙"\n} @else {\n  "丙"\n}\n';
    expect(await R(text, { a: true })).toBe("甲");
    expect(await R(text, { a: false, b: true })).toBe("乙");
    expect(await R(text, { a: false, b: false })).toBe("丙");
  });

  test("@for 空迭代走 else-if 链", async () => {
    const text = '@for v in tags {\n  "{v}"\n} @else @if(flag) {\n  "有标记"\n} @else {\n  "无标记"\n}\n';
    expect(await R(text, { tags: {}, flag: true })).toBe("有标记");
    expect(await R(text, { tags: {}, flag: false })).toBe("无标记");
    expect(await R(text, { tags: { a: "A" } })).toBe("A");
  });

  test("独立行 @else @if 链渲染", async () => {
    const text = '@if(a) {\n  "甲"\n}\n@else @if(b) {\n  "乙"\n}\n@else {\n  "丙"\n}\n';
    expect(await R(text, { a: false, b: true })).toBe("乙");
  });
});
