import { psError, type ErrorStage } from "./errors.js";
import type { Mode, Pos } from "./ast.js";

export const DIRECTIVES = ["set", "if", "else", "include", "for"] as const;

export type LineKind = "blank" | "directive" | "raw" | "literal" | "close" | "closeElse";

export interface ScannedLine {
  kind: LineKind;
  line: number;
  text: string;
  directive?: string;
  payload?: string;
}

const DIRECTIVE_RE = /^@([a-zA-Z]+)/;

export function scanLine(raw: string, line: number, mode: Mode): ScannedLine {
  const text = raw.replace(/\s+$/, "");
  if (text.trim() === "") return { kind: "blank", line, text: "" };
  const t = text.trimStart();
  if (t.startsWith("@")) {
    const m = DIRECTIVE_RE.exec(t);
    const name = m?.[1];
    if (!name || !(DIRECTIVES as readonly string[]).includes(name)) {
      throw psError("parse", "", line, "E_UNKNOWN_DIRECTIVE",
        `未知指令 @${name ?? t.slice(1).split(/[^\w]/)[0]}；已知指令：${DIRECTIVES.join("/")}`);
    }
    return { kind: "directive", line, text, directive: name, payload: t.slice(name.length + 1).trim() };
  }
  if (t.startsWith("}")) {
    // 同行连接：} @else …（payload 为 @else 之后的部分：`{` 或 `@if(…) {`；空串由解析器报错）
    const m = /^}\s*@else\b(.*)$/.exec(t);
    if (m) return { kind: "closeElse", line, text, payload: m[1]!.trim() };
    if (t !== "}") {
      throw psError("parse", "", line, "E_SYNTAX",
        "`}` 必须独占一行闭合块，或同行连接 `@else {` / `@else @if(expr) {`");
    }
    return { kind: "close", line, text };
  }
  if (mode === "article") return { kind: "raw", line, text };
  // code 模式：整体必须是引号字符串
  const first = text.trimStart().charAt(0);
  if (first !== '"' && first !== "'") {
    throw psError("parse", "", line, "E_EXPECT_STRING",
      "代码模式（花括号块内）每行必须是语句或带引号的字符串字面量");
  }
  scanParts(text, "", line, { outerQuote: first as '"' | "'" }); // 只做合法性检查
  return { kind: "literal", line, text };
}

export type Part = { text: string } | { expr: string };

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };

/** 统一槽位/插值读取器：括号深度 + 引号感知 */
export function scanParts(
  src: string,
  file: string,
  line: number,
  opts: { outerQuote?: '"' | "'" },
): Part[] {
  const parts: Part[] = [];
  let depth = 0;                 // 0 = 槽外；≥1 = 槽内
  let nestedQuote: string | null = null;
  let buf = "";                  // 当前文本段缓冲
  let slotStart = -1;
  let i = 0;
  let opened = false;            // outerQuote 模式：是否已越过开头引号
  if (opts.outerQuote) {
    // 前导空白是排版（代码模式缩进），不入内容；文章模式（无 outerQuote）不跳过
    while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  }

  const flushText = () => { if (buf !== "") { parts.push({ text: buf }); buf = ""; } };
  const fail = (code: string, msg: string): never => { throw psError("parse", file, line, code, msg); };

  while (i < src.length) {
    const c = src[i];
    if (depth === 0) {
      // 槽外：外层引号 / 开槽 / 转义
      if (opts.outerQuote) {
        if (c === opts.outerQuote) {
          if (!opened) { opened = true; i++; continue; } // 跳过开头引号（允许前导空白缩进）
          flushText();
          if (i + 1 < src.length) fail("E_SYNTAX", "字符串字面量后存在多余内容");
          return parts;          // 字符串结束
        }
        if (c === "{") { slotStart = i; depth = 1; flushText(); i++; continue; }
        if (c === "\\") {
          const n = src[i + 1];
          if (n === undefined) fail("E_UNCLOSED_STRING", "字符串以反斜杠结尾");
          buf += ESCAPES[n!] ?? n;
          i += 2;
          continue;
        }
        buf += c; i++; continue;
      }
      // 文章行模式
      if (c === "{") { slotStart = i; depth = 1; flushText(); i++; continue; }
      if (c === "}") fail("E_STRAY_BRACE", "孤立的 `}`（输出字面花括号请用 `\\}`）");
      if (c === "\\") {
        const n = src[i + 1];
        if (n === undefined) { buf += "\\"; i++; continue; }
        if (n === "{" || n === "}" || n === "\\") { buf += n; }
        else { buf += "\\" + n; }
        i += 2;
        continue;
      }
      buf += c; i++; continue;
    }
    // 槽内（深度 ≥ 1）
    if (nestedQuote) {
      if (c === "\\") { buf += c + (src[i + 1] ?? ""); i += 2; continue; } // 保留转义供表达式层解码（\" 等）
      if (c === nestedQuote) nestedQuote = null;
      buf += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { nestedQuote = c; buf += c; i++; continue; }
    if (c === "\\") {
      if (src[i + 1] === "}") { buf += "}"; }      // \} → } 进槽内容（拼回槽文本）
      else if (src[i + 1] === "{") { buf += "\\{"; }
      else { buf += c + (src[i + 1] ?? ""); }
      i += 2;
      continue;
    }
    if (c === "{") { depth++; buf += c; i++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        const content = buf;
        buf = "";
        parts.push({ expr: content });
        slotStart = -1;
        i++;
        continue;
      }
      buf += c; i++; continue;
    }
    buf += c; i++;
  }
  if (depth > 0) {
    if (opts.outerQuote) fail("E_UNCLOSED_STRING", "字符串未闭合（缺外层引号）");
    fail("E_UNCLOSED_SLOT", "槽位未闭合（缺 `}`）");
  }
  if (opts.outerQuote) fail("E_UNCLOSED_STRING", "字符串未闭合（缺外层引号）");
  flushText();
  return parts;
}

/** 表达式级字符串解码（T3 复用）：src 必须是完整引号串 */
export function decodeStringValue(src: string): string {
  const q = src.charAt(0);
  const body = src.slice(1, src.length - 1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const n = body[i + 1];
      if (n === undefined) { out += "\\"; continue; }
      out += ESCAPES[n] ?? n;
      i++;
      continue;
    }
    if (c === q) throw new Error(`decodeStringValue: 未转义的 ${q}`);
    out += c;
  }
  return out;
}

// ─── C 风格注释 ───
export interface CommentState { inBlock: boolean; startLine: number }

/**
 * C 风格注释剥离：行首 // 整行注释、行首 /* 跨行块注释、指令/代码行尾部注释（引号感知）。
 * 返回 null = 整行是注释（调用方跳过该行）；跨行块状态经 state 保持。
 */
export function stripComments(
  raw: string,
  file: string,
  line: number,
  state: CommentState,
  inCodeMode: boolean,
): string | null {
  let s = raw;
  // Phase A：行首标记与跨行块状态（循环——块关闭后剩余内容可能又是行首标记）
  for (;;) {
    if (state.inBlock) {
      const close = s.indexOf("*/");       // C 语义：块内第一个 */ 关闭，不引号感知
      if (close === -1) return null;       // 整行被块注释消费
      state.inBlock = false;
      const rest = s.slice(close + 2);
      if (rest.trim() === "") return null; // 块注释单独成行：整行擦除（不产生空行）
      s = rest;
      continue;
    }
    const t = s.trimStart();
    if (t.startsWith("\\//") || t.startsWith("\\/*")) {
      // 行首转义：\// 与 \/* 是字面内容（剥掉反斜杠），该行不再做任何注释识别
      const bs = s.length - t.length;      // 反斜杠在 s 中的位置
      return s.slice(0, bs) + s.slice(bs + 1);
    }
    if (t.startsWith("//")) return null;   // 整行注释
    if (t.startsWith("/*")) {
      state.inBlock = true;
      state.startLine = line;
      continue;                            // 下一轮循环找 */
    }
    if (t.startsWith("*/")) {
      throw psError("parse", file, line, "E_COMMENT_STRAY", "多余的 `*/`（没有对应的 `/*`）");
    }
    break;
  }
  // Phase B：指令行（@ 开头）与代码模式行的尾部注释剥离（引号感知）
  if (inCodeMode || s.trimStart().startsWith("@")) {
    s = stripTrailingComments(s, file, line, state);
  }
  return s;
}

function stripTrailingComments(s: string, file: string, line: number, state: CommentState): string {
  let out = "";
  let i = 0;
  let nested: string | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (nested) {
      if (c === "\\") { out += c + (s[i + 1] ?? ""); i += 2; continue; }
      out += c;
      if (c === nested) nested = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { nested = c; out += c; i++; continue; }
    if (c === "/" && s[i + 1] === "/") return out;                       // 行注释：截断
    if (c === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 1);
      if (close === -1) { state.inBlock = true; state.startLine = line; return out; } // 进跨行块
      i = close + 2;
      continue;
    }
    if (c === "*" && s[i + 1] === "/") {
      throw psError("parse", file, line, "E_COMMENT_STRAY", "多余的 `*/`（没有对应的 `/*`）");
    }
    out += c;
    i++;
  }
  return out;
}
