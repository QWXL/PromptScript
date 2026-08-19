import { readFileSync } from "node:fs";
import path from "node:path";
import { PromptScript, PromptScriptError, psError, parseToPSValue, type PSValue } from "./index.js";

export interface CLIEnv {
  stdin: () => Promise<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
}

const USAGE = `usage: promptscript <command> [args]

commands:
  check <file…| ->          语法/静态作用域检查（- 读 stdin），exit 0/1
  render <file|- > [values.json] [-v key=value …]   渲染（- 读 stdin）
  --version                 打印版本
  --help                    本帮助
`;

// 偏差注（Task 7 实现期）：brief 原文仅 new URL("../package.json", import.meta.url) 一处——
// 编译后 dist/src/cli.js 的 ../ 解析到 dist/package.json（不存在）→ 构建冒烟得 "0.0.0" 而非 0.1.0。
// 最小修复：../ 失败后回退 ../../（dist 两层目录），源树（vitest 从 src/ 读 ../）与
// dist 双位置均命中根 package.json。file:// URL 直读技巧保留（避免 Windows pathname 的 /C:/ 前缀坑）。
const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    try {
      return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
    } catch {
      return "0.0.0";
    }
  }
})();

export async function runCLI(argv: string[], env: CLIEnv): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) { env.stdout(USAGE); return 0; }
  if (cmd === "--version") { env.stdout(`${version}\n`); return 0; }
  if (cmd === "check") return checkCmd(rest, env);
  if (cmd === "render") return renderCmd(rest, env);
  env.stderr(USAGE);
  return 2;
}

async function readInput(target: string, env: CLIEnv): Promise<string> {
  if (target === "-") return env.stdin();
  return readFileSync(path.resolve(env.cwd, target), "utf8");
}

async function checkCmd(args: string[], env: CLIEnv): Promise<number> {
  if (args.length === 0) { env.stderr("check 需要至少一个文件（- 表示 stdin）\n"); return 2; }
  let failed = false;
  for (const f of args) {
    try {
      if (f === "-") {
        const text = await env.stdin();
        const ps = new PromptScript(text, { loadFile: undefined });
        await ps.resolve();
      } else {
        await PromptScript.load(path.resolve(env.cwd, f));
      }
      env.stdout(`OK ${f}\n`);
    } catch (e) {
      failed = true;
      if (e instanceof PromptScriptError) env.stderr(`${e}\n`);
      else env.stderr(`${f}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return failed ? 1 : 0;
}

async function renderCmd(args: string[], env: CLIEnv): Promise<number> {
  const target = args[0];
  if (target === undefined) { env.stderr("render 需要一个输入（文件或 -）\n"); return 2; }
  // 偏差注（Task 7 实现期）：brief 原文 find(a => !a.startsWith("-")) 会把 -v 的"值"（如 a=值）误当
  // values.json 路径 → 自身测试（render - -v a=值）报 ENOENT exit 1。最小修复：跳过紧跟在 -v 后的参数。
  // 同时 kv 循环的 args[i + 1] 在 noUncheckedIndexedAccess 下无收窄（TS2532 ×3，brief 代码无法过 tsc）
  // → 提为局部变量（语义不变）。
  const jsonFile = args.slice(1).find((a, i) => !a.startsWith("-") && args[i] !== "-v");
  const kv: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], val = args[i + 1];
    if (flag === "-v" && val) {
      const eq = val.indexOf("=");
      if (eq > 0) kv[val.slice(0, eq)] = val.slice(eq + 1);
    }
  }
  try {
    const values: Record<string, PSValue> = {};
    if (jsonFile) {
      const raw = readFileSync(path.resolve(env.cwd, jsonFile), "utf8");
      const parsed: unknown = JSON.parse(raw);
      // JSON 顶层必须是纯对象；逐键收窄为 PSValue（数组/非 PSValue 结构 → E_TYPE）。
      // 用 Object.entries 而非 Object.assign：避免 {"__proto__": …} 触发原型 setter 陷阱
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw psError("render", jsonFile, 0, "E_TYPE", "values.json 顶层必须是对象");
      }
      for (const [k, v] of Object.entries(parsed)) values[k] = parseToPSValue(v, `values.${k}`);
    }
    // 偏差注（控制器定稿 Task 6 Minor #3）：brief 原文对文件输入走静态 PromptScript.render(text, ...)——
    // 匿名文档无 file 上下文，含 @include 的文件抛 E_SYNTAX。文件输入改用 PromptScript.load
    // （file 上下文 + 默认 fs loadFile，load 内部已 await resolve，相对 include 正常）；
    // 仅 stdin（-）走静态 render（stdin 无文件系统上下文，include 报 E_INCLUDE_NO_LOADER 合理）。
    // kv（-v 键值对）恒为字符串，本就是 PSValue，无需转换。
    const out = target === "-"
      ? await PromptScript.render(await readInput(target, env), values, kv)
      : (await PromptScript.load(path.resolve(env.cwd, target))).render(values, kv);
    // 偏差注：brief 原文 stdout(`${out}\n`) 自带换行，但 renderDocument 已丢弃输入尾随换行（幽灵空行），
    // brief 自身测试期望输出精确等于 "你好 值 2"（无尾随换行）→ 不再追加。
    env.stdout(out);
    return 0;
  } catch (e) {
    if (e instanceof PromptScriptError) env.stderr(`${e}\n`);
    else env.stderr(`${target}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
