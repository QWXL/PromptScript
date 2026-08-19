import type { Expr } from "./ast.js";
import { psError } from "./errors.js";
import { decodeStringValue } from "./lexer.js";

// ─── tokenize ───
type TKind = "ident" | "string" | "number" | "op" | "eof";
interface Token { kind: TKind; value: string; pos: number }

const OPS = ["??", "||", "&&", "==", "!=", "!=", "<", ">", "!", "?", ":", "(", ")", "[", "]", "{", "}", ",", "|"];
const OP_CHARS = new Set("{}()[],:?|&!=<>\"'\\ \t".split(""));

function tokenize(src: string, file: string, line: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t") { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let body = "";
      let closed = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\\") { body += d + (src[j + 1] ?? ""); j += 2; continue; }
        if (d === q) { closed = true; break; }
        body += d; j++;
      }
      if (!closed) throw psError("parse", file, line, "E_EXPR", `字符串字面量未闭合：${src.slice(i, i + 20)}`);
      out.push({ kind: "string", value: body, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i));
      out.push({ kind: "number", value: m![0], pos: i });
      i += m![0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS.includes(two)) { out.push({ kind: "op", value: two, pos: i }); i += 2; continue; }
    if (OPS.includes(c)) { out.push({ kind: "op", value: c, pos: i }); i += 1; continue; }
    // 偏差注：brief 原文 /[\p{L}\p{N}_]/ 缺 u 标志——非 u 模式下 \p 是字面 "p"，字母永不匹配；补 u
    if (c === "." || c === "-" || c === "#" || /[\p{L}\p{N}_]/u.test(c)) {
      let j = i;
      while (j < src.length && !OP_CHARS.has(src[j]!)) j++;
      out.push({ kind: "ident", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw psError("parse", file, line, "E_EXPR", `意外的字符：${c}`);
  }
  out.push({ kind: "eof", value: "", pos: src.length });
  return out;
}

// ─── 递归下降 ───
class ExprParser {
  private p = 0;
  constructor(private toks: Token[], private file: string, private line: number) {}

  private peek(): Token { return this.toks[this.p] ?? this.toks[this.toks.length - 1]!; }
  private next(): Token { return this.toks[this.p++] ?? this.toks[this.toks.length - 1]!; }
  private fail(msg: string): never { throw psError("parse", this.file, this.line, "E_EXPR", msg); }
  private expectOp(op: string): void {
    const t = this.next();
    if (t.kind !== "op" || t.value !== op) this.fail(`期望 ${op}，得到 ${t.value || "结束"}`);
  }

  parse(): Expr { return this.ternary(); }

  private ternary(): Expr {
    const test = this.coalesce();
    if (this.peek().kind === "op" && this.peek().value === "?") {
      this.next();
      const yes = this.ternary();
      this.expectOp(":");
      const no = this.ternary();
      return { kind: "cond", test, yes, no };
    }
    return test;
  }

  private coalesce(): Expr {
    let left = this.or();
    while (this.peek().kind === "op" && this.peek().value === "??") {
      this.next();
      // 右侧是任意表达式（or 级：?? 比 || 紧、比 ?: 松，与规范 2.3 优先级表一致）；
      // 链式靠 while 保持左结合：a ?? b ?? c → (a ?? b) ?? c
      left = { kind: "coalesce", left, right: this.or() };
    }
    return left;
  }

  private or(): Expr {
    let left = this.and();
    while (this.peek().kind === "op" && this.peek().value === "||") {
      this.next();
      left = { kind: "logical", op: "||", left, right: this.and() };
    }
    return left;
  }

  private and(): Expr {
    let left = this.eq();
    while (this.peek().kind === "op" && this.peek().value === "&&") {
      this.next();
      left = { kind: "logical", op: "&&", left, right: this.eq() };
    }
    return left;
  }

  private eq(): Expr {
    let left = this.rel();
    while (this.peek().kind === "op" && (this.peek().value === "==" || this.peek().value === "!=")) {
      const op = this.next().value as "==" | "!=";
      left = { kind: "compare", op, left, right: this.rel() };
    }
    return left;
  }

  private rel(): Expr {
    let left = this.unary();
    while (this.peek().kind === "op" && (this.peek().value === "<" || this.peek().value === ">")) {
      const op = this.next().value as "<" | ">";
      left = { kind: "compare", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Expr {
    if (this.peek().kind === "op" && this.peek().value === "!") {
      this.next();
      return { kind: "not", operand: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    while (this.peek().kind === "op" && this.peek().value === "[") {
      this.next(); // 消费 [
      // 下标即完整表达式（可嵌套 a[b[c]]、三元、括号），同一解析器直接解析，无需子解析器+游标同步
      const idx = this.ternary();
      this.expectOp("]");
      e = { kind: "index", obj: e, index: idx };
    }
    return e;
  }

  private primary(): Expr {
    const t = this.next();
    if (t.kind === "ident") {
      if (t.value === "true" || t.value === "false" || t.value === "null") {
        return { kind: "literal", value: t.value === "true" ? true : t.value === "false" ? false : null };
      }
      return { kind: "path", name: t.value };
    }
    if (t.kind === "string") return { kind: "literal", value: decodeStringValue(`"${t.value}"`) };
    if (t.kind === "number") return { kind: "literal", value: Number(t.value) };
    if (t.kind === "op" && t.value === "(") {
      const e = this.ternary();
      this.expectOp(")");
      return e;
    }
    if (t.kind === "op" && t.value === "{") return this.record();
    this.fail(`期望表达式，得到 ${t.value || "结束"}`);
  }

  private record(): Expr {
    const entries: [string, string | number | boolean | null][] = [];
    while (!(this.peek().kind === "op" && this.peek().value === "}")) {
      const keyT = this.next();
      let key: string;
      if (keyT.kind === "ident") key = keyT.value;
      else if (keyT.kind === "string") key = decodeStringValue(`"${keyT.value}"`);
      else if (keyT.kind === "number") key = keyT.value;
      else this.fail("记录键必须是裸标识符/引号字符串/数字");
      this.expectOp(":");
      const valT = this.next();
      if (valT.kind === "string" || valT.kind === "number") {
        entries.push([key, valT.kind === "string" ? decodeStringValue(`"${valT.value}"`) : Number(valT.value)]);
      } else if (valT.kind === "ident" && ["true", "false", "null"].includes(valT.value)) {
        entries.push([key, valT.value === "true" ? true : valT.value === "false" ? false : null]);
      } else {
        this.fail("记录值仅限字面量（字符串/数字/true/false/null）");
      }
      if (this.peek().kind === "op" && this.peek().value === ",") {
        this.next();
        if (this.peek().kind === "op" && this.peek().value === "}") {
          this.fail("记录不允许尾逗号");
        }
      } else if (!(this.peek().kind === "op" && this.peek().value === "}")) {
        this.fail("记录条目需以逗号分隔");
      }
    }
    this.next(); // }
    return { kind: "record", entries };
  }
}

// ─── 统一入口：顶层回退分段 + 递归下降 ───
// 槽位（{expr}）、@set、@if 共用同一语法：| 回退在表达式最外层生效，?? 右侧任意表达式，
// || 一律是逻辑或。autoDetect / splitTop 分段 / parseExprGeneral 双轨制已合并为单一 parseExpr。

const NUM_RE = /^\d+(\.\d+)?$/;

/** 剥掉单层完全包裹的外层括号（引号感知）——@if 指令语法强制 `@if(expr) {`，括号剥掉后 | 回退才能按深度 0 处理 */
function stripOuterParens(src: string): string {
  const t = src.trim();
  if (t.length < 2 || t.charAt(0) !== "(" || t.charAt(t.length - 1) !== ")") return src;
  let depth = 0;
  let nested: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (nested) {
      if (c === "\\") { i++; continue; }
      if (c === nested) nested = null;
      continue;
    }
    if (c === '"' || c === "'") { nested = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      // 闭括号不在末尾 → 非完全包裹（如 `(a) b`），不剥
      if (depth === 0 && i !== t.length - 1) return src;
    }
  }
  return depth === 0 ? t.slice(1, -1).trim() : src;
}

/** 找深度 0 的 |（回退分隔符，返回下标；找不到返回 -1）。|| 整体跳过（那是逻辑或，归递归下降处理） */
function splitFallback(src: string): number {
  let depth = 0;
  let nested: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (nested) {
      if (c === "\\") { i++; continue; }
      if (c === nested) nested = null;
      continue;
    }
    if (c === '"' || c === "'") { nested = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]") { depth--; continue; }
    if (c === "}") { depth--; continue; }
    if (depth === 0 && c === "|") {
      if (src[i + 1] === "|") { i++; continue; }
      return i;
    }
  }
  return -1;
}

export function parseExpr(src: string, file: string, line: number): Expr {
  const t = stripOuterParens(src);
  const pipe = splitFallback(t);
  if (pipe >= 0) {
    // {a | 字面量}：左侧是表达式（递归——支持 (x | y) | z 嵌套），右侧按原文当字面量（不解析、不插值）
    return {
      kind: "coalesce",
      left: parseExpr(t.slice(0, pipe), file, line),
      right: { kind: "literal", value: parseLiteralValue(t.slice(pipe + 1), file, line) },
    };
  }
  const toks = tokenize(t, file, line);
  const parser = new ExprParser(toks, file, line);
  const e = parser.parse();
  const rest = parser["peek"]();
  if (rest.kind !== "eof") throw psError("parse", file, line, "E_EXPR", `表达式未完整：多余的 "${rest.value}"`);
  return e;
}

export function parseLiteralValue(src: string, file: string, line: number): string | number | boolean | null {
  const t = src.trim();
  if (t === "") return "";
  const first = t.charAt(0);
  if (first === '"' || first === "'") {
    const last = t.charAt(t.length - 1);
    if (last !== first) throw psError("parse", file, line, "E_EXPR", "字面量字符串未闭合");
    // fix 2：首尾引号之间出现未转义的同种引号 → 结构化 E_EXPR（带 file/line/code）；
    // decodeStringValue 的裸 Error 防御从此不可达
    for (let i = 1; i < t.length - 1; i++) {
      const c = t[i]!;
      if (c === "\\") { i++; continue; }
      if (c === first) throw psError("parse", file, line, "E_EXPR", "字面量字符串内存在未转义的引号");
    }
    return decodeStringValue(t);
  }
  if (NUM_RE.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  // 规范 2.4：\\ 永远转义为 \（未加引号的回退文本同样解码）；其余 \x 原样保留
  return t.replace(/\\\\/g, "\\");
}
