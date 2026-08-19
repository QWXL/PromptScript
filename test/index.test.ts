import { describe, test, expect } from "vitest";
import { PromptScript, PromptScriptError } from "../src/index.js";

const err = async (fn: () => Promise<unknown> | unknown, code: string) => {
  try { await fn(); } catch (e) { expect((e as PromptScriptError).code).toBe(code); return; }
  throw new Error(`期望抛出 ${code} 但没抛`);
};

describe("PromptScript 公开 API", () => {
  test("load + collectMissing + render 全流程（含 include）", async () => {
    const fs: Record<string, string> = {
      "/t/main.ps": '@include("frag.ps")\n主文件{vip}\n',
      "/t/frag.ps": "片段{env.weather | 未知}\n",
    };
    const ps = await PromptScript.load("/t/main.ps", { loadFile: async (p) => fs[p] ?? (() => { throw new Error("x"); })() });
    expect(ps.collectMissing().sort()).toEqual(["vip", "env.weather"].sort());
    expect(ps.render({ vip: "svip", "env.weather": "晴" })).toBe("片段晴\n主文件svip");
  });

  test("构造 + resolve 幂等 + args 优先", async () => {
    const ps = new PromptScript("你好 {a}", { file: "/t/m.ps" });
    await ps.resolve();
    await ps.resolve(); // 幂等
    expect(ps.render({ a: "v" }, { a: "A" })).toBe("你好 A");
  });

  test("静态 render 一条龙", async () => {
    expect(await PromptScript.render("你好 {a ?? \"x\"}", { a: "v" })).toBe("你好 v");
    expect(await PromptScript.render("你好 {a ?? \"x\"}", {})).toBe("你好 x");
  });

  test("语法错误在构造时抛（带 file）", () => {
    expect(() => new PromptScript("@if(a)\n", { file: "/t/bad.ps" })).toThrow(PromptScriptError);
    try { new PromptScript("@if(a)\n", { file: "/t/bad.ps" }); } catch (e) {
      expect((e as PromptScriptError).file).toBe("/t/bad.ps");
    }
  });

  test("include 无 loadFile → E_INCLUDE_NO_LOADER", async () => {
    const ps = new PromptScript('@include("x.ps")', { file: "/t/m.ps" });
    await err(() => ps.resolve(), "E_INCLUDE_NO_LOADER");
  });

  test("块嵌套 include：无 loadFile → E_INCLUDE_NO_LOADER；有 loadFile → resolve 成功（Task 6 Minor #2 回归）", async () => {
    const text = '@if(ok) {\n  @include("x.ps")\n}\n';
    await err(() => new PromptScript(text, { file: "/t/m.ps" }).resolve(), "E_INCLUDE_NO_LOADER");
    const ps = new PromptScript(text, { file: "/t/m.ps", loadFile: async () => "片段\n" });
    await expect(ps.resolve()).resolves.toBeUndefined();
    expect(ps.render({ ok: true })).toContain("片段");
    expect(ps.render({ ok: false })).toBe("");
  });

  test("未 resolve 就 render → E_UNRESOLVED", () => {
    const ps = new PromptScript('@include("x.ps")', { file: "/t/m.ps", loadFile: async () => "" });
    expect(() => ps.render({})).toThrow();
    try { ps.render({}); } catch (e) { expect((e as PromptScriptError).code).toBe("E_UNRESOLVED"); }
  });

  test("collectMissing 与 render 对未 resolve 的 include 同守卫", () => {
    const ps = new PromptScript('@include("x.ps")', { file: "/t/m.ps", loadFile: async () => "" });
    try { ps.collectMissing(); } catch (e) { expect((e as PromptScriptError).code).toBe("E_UNRESOLVED"); }
  });

  test("同一路径多个 include 节点（顶层 + 循环体）→ loadFile 只读一次", async () => {
    const fs: Record<string, string> = {
      "/t/main.ps": '@include("frag.ps")\n@for i in 1..2 {\n  @include("frag.ps")\n}\n',
      "/t/frag.ps": "片段\n",
    };
    let calls = 0;
    const ps = await PromptScript.load("/t/main.ps", { loadFile: async (p) => { calls++; return fs[p] ?? (() => { throw new Error("x"); })(); } });
    expect(calls).toBe(2);   // 主文件 1 次 + frag 1 次（两节点共享缓存）
    expect(ps.render({})).toBe("片段\n片段\n片段");
    expect(calls).toBe(2);   // 渲染期不读盘
  });
});
