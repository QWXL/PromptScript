import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCLI, type CLIEnv } from "../src/cli.js";

const env = (opts: { stdinText?: string; fs?: Record<string, string> } = {}): CLIEnv & { out: string; err: string } => {
  const out: string[] = [], err: string[] = [];
  return {
    stdin: async () => opts.stdinText ?? "",
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    cwd: "/t",
    out, err,
  };
};

describe("check", () => {
  test("合法文件 → OK + exit 0", async () => {
    const e = env({ fs: {} });
    // 直接渲染文件不存在，改用 stdin
    const e2 = env({ stdinText: '你好 {a ?? "x"}\n' });
    const code = await runCLI(["check", "-"], e2);
    expect(code).toBe(0);
    expect(e2.out.join("")).toContain("OK");
  });

  test("语法错误 → 错误行 + exit 1", async () => {
    // 偏差注：brief 原文输入 @if(a)\n 在 Task 4 解析器中报 E_IF_EXPECT_BRACE（@if 必须以 { 结束）
    // 而非 E_BLOCK_UNCLOSED——改用 @if(a) {\n（块已开未闭，EOF 报 E_BLOCK_UNCLOSED），断言不变。
    const e = env({ stdinText: "@if(a) {\n" });
    const code = await runCLI(["check", "-"], e);
    expect(code).toBe(1);
    expect(e.err.join("")).toContain("[E_BLOCK_UNCLOSED]");
  });

  test("check 通过含注释的文档", async () => {
    const e = env({ stdinText: "// 整行注释\n@set x = a // 尾部\n{x}\n" });
    const code = await runCLI(["check", "-"], e);
    expect(code).toBe(0);
    expect(e.out.join("")).toContain("OK");
  });
});

describe("render", () => {
  test("stdin 渲染 + -v 覆盖 json", async () => {
    const e = env({ stdinText: '你好 {a ?? "缺"} {b}\n' });
    const code = await runCLI(["render", "-", "-v", "a=值", "-v", "b=2"], e);
    expect(code).toBe(0);
    expect(e.out.join("")).toBe("你好 值 2");
  });

  test("values.json 相对 cwd", async () => {
    const e = env({ stdinText: "{a}\n" });
    e.cwd = "/t";
    const code = await runCLI(["render", "-", "vals.json"], {
      ...e, stdin: async () => "{a}\n",
    });
    // vals.json 不存在 → 报错 exit 1
    expect(code).toBe(1);
    expect(e.err.join("")).toContain("vals.json");
  });

  test("渲染错误 → exit 1 且输出到 stderr", async () => {
    const e = env({ stdinText: "{missing}\n" });
    const code = await runCLI(["render", "-"], e);
    expect(code).toBe(1);
    expect(e.err.join("")).toContain("[E_UNBOUND]");
  });
});

describe("render values.json 校验（parseToPSValue）", () => {
  // cli 用真实 readFileSync + path.resolve（env.fs 地图不生效）→ 临时目录真写文件
  const tmp = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ps-"));
    return {
      json: (name: string, content: string): string => {
        const p = path.join(dir, name);
        writeFileSync(p, content);
        return p;
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  };

  test("values.json 含数组 → E_TYPE + exit 1", async () => {
    const t = tmp();
    try {
      const json = t.json("vals.json", '{"a": [1, 2]}');
      const e = env({ stdinText: "{a}\n" });
      const code = await runCLI(["render", "-", json], e);
      expect(code).toBe(1);
      expect(e.err.join("")).toContain("[E_TYPE]");
      expect(e.err.join("")).toContain("数组");
    } finally { t.cleanup(); }
  });

  test("values.json 嵌套数组 → E_TYPE（键路径在消息中）", async () => {
    const t = tmp();
    try {
      const json = t.json("vals.json", '{"a": {"b": [1]}}');
      const e = env({ stdinText: "{a}\n" });
      const code = await runCLI(["render", "-", json], e);
      expect(code).toBe(1);
      expect(e.err.join("")).toContain("[E_TYPE]");
      expect(e.err.join("")).toContain("values.a.b");
    } finally { t.cleanup(); }
  });

  test("values.json 顶层非对象 → E_TYPE", async () => {
    const t = tmp();
    try {
      const json = t.json("vals.json", "[1, 2]");
      const e = env({ stdinText: "{a}\n" });
      const code = await runCLI(["render", "-", json], e);
      expect(code).toBe(1);
      expect(e.err.join("")).toContain("[E_TYPE]");
    } finally { t.cleanup(); }
  });

  test("合法 values.json（嵌套对象）+ -v 覆盖", async () => {
    const t = tmp();
    try {
      const json = t.json("vals.json", '{"user": {"name": "阿月"}, "a": 1}');
      const e = env({ stdinText: "{user.name}/{a}\n" });
      const code = await runCLI(["render", "-", json, "-v", "a=覆盖"], e);
      expect(code).toBe(0);
      expect(e.out.join("")).toBe("阿月/覆盖");
    } finally { t.cleanup(); }
  });
});

describe("usage/version", () => {
  test("--version 输出版本", async () => {
    const e = env();
    const code = await runCLI(["--version"], e);
    expect(code).toBe(0);
    expect(e.out.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("未知参数 → usage + exit 2", async () => {
    const e = env();
    const code = await runCLI(["--bogus"], e);
    expect(code).toBe(2);
    expect(e.err.join("")).toContain("usage");
  });
});
