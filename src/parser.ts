import path from "node:path";
import type { Expr, Pos } from "./ast.js";
import { psError, PromptScriptError } from "./errors.js";
import { scanLine, scanParts, decodeStringValue, stripComments, type CommentState } from "./lexer.js";
import { parseExpr, parseLiteralValue } from "./expr.js";

export interface Decl { name: string; expr: Expr; file: string; line: number }

export type ForIterable =
  | { kind: "range"; from: number; to: number }
  | { kind: "expr"; expr: Expr };

export type Node =
  | { type: "blank"; file: string; line: number }
  | { type: "raw"; file: string; line: number; parts: (string | Expr)[] }
  | { type: "literal"; file: string; line: number; parts: (string | Expr)[] }
  | { type: "block"; file: string; line: number; cond: Expr; ifLines: Node[]; elseLines: Node[] | null }
  | { type: "for"; file: string; line: number; vars: string[]; iterable: ForIterable; body: Node[]; elseLines: Node[] | null }
  | { type: "include"; file: string; line: number; path: string; doc: Document | null };

export interface Document {
  file: string;
  decls: Decl[];
  lines: Node[];
  parent: Document | null;
}

export type LoadFile = (path: string) => Promise<string> | string;

// 偏差注：brief 原文 path.resolve 在 win32 上把 "/root/a.ps" 解析为 "C:\root\..."（带盘符），
// 与测试（及文档）的 POSIX 路径约定不符；统一用 path.posix 保证跨平台确定性结果。
// （Windows 下 Node fs 接受正斜杠路径，真实 loadFile 不受影响。）
// Fix（Review Finding 1）：win32 反斜杠父路径（C:\dir\main.ps）先归一化为正斜杠再做 posix 运算，
// 否则 posix.dirname 把反斜杠当普通字符、dirname 塌缩为 "."，相对 include 会错误地对着 cwd 解析。
export function resolveIncludePath(parentFile: string, rawPath: string): string {
  const dir = parentFile ? path.posix.dirname(parentFile.replace(/\\/g, "/")) : "";
  // posix 语义不认盘符前缀为绝对路径（resolve("C:/dir", …) 会把盘符当相对路径拼上 cwd）：
  // 盘符绝对父路径（C:/dir 或盘符根 C:）加 "/" 前缀使其绝对化、resolve 后还原前缀，
  // 得 C:/dir/sub/x.ps 这类确定结果（双平台一致）；POSIX 绝对 include target 不受影响。
  if (!rawPath.startsWith("/") && /^[A-Za-z]:(\/|$)/.test(dir)) {
    return path.posix.resolve("/" + dir.replace(/^([A-Za-z]:)\/?$/, "$1/"), rawPath).slice(1);
  }
  return path.posix.resolve(dir, rawPath);
}

interface BlockEntry {
  file: string; line: number;
  cond?: Expr; iterable?: ForIterable; vars?: string[];
  ifLines: Node[]; elseLines: Node[] | null; attachTo?: Node;
  fillIfLines?: boolean;   // else-if 链：闭合时把 ifLines 回填到预置节点
}
interface ClosedBlock { cond?: Expr; iterable?: ForIterable; vars?: string[]; ifLines: Node[]; elseLines: Node[] | null }

class DocParser {
  private lines: Node[] = [];
  private decls: Decl[] = [];
  private stack: BlockEntry[] = [];
  private lastClosed: { block: ClosedBlock; depth: number } | null = null;
  private depth = 0; // 当前 block 嵌套深度
  private commentState: CommentState = { inBlock: false, startLine: 0 }; // C 风格注释跨行块状态

  constructor(private text: string, private file: string) {}

  private fail(line: number, code: string, msg: string): never {
    throw psError("parse", this.file, line, code, msg);
  }

  // 偏差注：brief 原文 private run——parseDocument 在类外调用 run()，TS2341；去 private
  run(): Document {
    const srcLines = this.text.split("\n");
    for (let i = 0; i < srcLines.length; i++) {
      const raw = srcLines[i]!;
      // C 风格注释解析期剥离：整行注释 → 跳过（不产生节点）；跨行块状态跨行保持
      const stripped = stripComments(raw, this.file, i + 1, this.commentState, this.depth > 0);
      if (stripped === null) continue;
      let scanned;
      try {
        scanned = scanLine(stripped, i + 1, this.depth === 0 ? "article" : "code");
      } catch (e) {
        // lexer 抛错时 file 未知（""），这里补上文档路径再抛
        // Fix（Review Finding 2）：lexer 消息形如 ":3: [E_UNKNOWN_DIRECTIVE] …"，原正则只剥 ":3: "，
        // 代码括号残留导致重抛后 "[CODE]" 出现两次；一并剥掉定位前缀与代码括号。
        if (e instanceof PromptScriptError && e.file === "") {
          throw psError("parse", this.file, e.line, e.code, e.message.replace(/^:?\d+: \[[^\]]*\]\s*/, ""));
        }
        throw e;
      }
      switch (scanned.kind) {
        case "blank":
          if (this.depth === 0) this.lines.push({ type: "blank", file: this.file, line: i + 1 });
          break;
        case "close":
          this.closeBlock(i + 1);
          break;
        case "directive": {
          switch (scanned.directive) {
            case "set": {
              if (this.depth > 0) this.fail(i + 1, "E_SET_IN_BLOCK", "@set 仅限顶层（花括号块内声明 → 错误）");
              const m = /^([^\s=]+)\s*=\s*(.*)$/s.exec(scanned.payload ?? "");
              if (!m) this.fail(i + 1, "E_SYNTAX", "@set 格式：@set name = expr");
              const name = m[1]!;
              if (this.decls.some((x) => x.name === name)) this.fail(i + 1, "E_DUP_DECL", `重复声明 @set ${name}`);
              const expr = parseExpr(m[2]!, this.file, i + 1);
              this.decls.push({ name, expr, file: this.file, line: i + 1 });
              break;
            }
            case "if":
              this.pushIf(scanned.payload ?? "", i + 1);
              break;
            case "else":
              this.handleElse(scanned.payload ?? "", i + 1);
              break;
            case "include": {
              const inner = (scanned.payload ?? "").trim();
              // @include("path") 的 payload 带括号（@if 同款），剥掉括号再按字面量解析
              const m = /^\((.*)\)$/.exec(inner);
              const litSrc = m ? m[1]! : inner;
              const v = parseLiteralValue(litSrc, this.file, i + 1);
              if (typeof v !== "string") this.fail(i + 1, "E_EXPR", "@include 参数必须是引号字符串路径");
              this.currentLines().push({ type: "include", file: this.file, line: i + 1, path: v, doc: null });
              break;
            }
            case "for": {
              const payload = scanned.payload ?? "";
              if (!payload.endsWith("{")) this.fail(i + 1, "E_FOR_EXPECT_BRACE", "@for 必须以 `{` 结束（@for v in expr {）");
              const inner = payload.slice(0, payload.length - 1).trimEnd();
              const [vars, iterable] = this.parseForHead(inner, i + 1);
              this.stack.push({ file: this.file, line: i + 1, vars, iterable, ifLines: [], elseLines: null });
              this.depth++;
              break;
            }
          }
          break;
        }
        case "closeElse":
          this.closeBlock(i + 1);
          this.handleElse(scanned.payload ?? "", i + 1);
          break;
        case "raw": {
          const parts = this.toParts(scanned.text, i + 1, null);
          this.lines.push({ type: "raw", file: this.file, line: i + 1, parts });
          break;
        }
        case "literal": {
          const first = scanned.text.trimStart().charAt(0) as '"' | "'";
          const parts = this.toParts(scanned.text, i + 1, first);
          this.currentLines().push({ type: "literal", file: this.file, line: i + 1, parts });
          break;
        }
      }
    }
    if (this.commentState.inBlock) {
      throw psError("parse", this.file, this.commentState.startLine, "E_COMMENT_UNCLOSED",
        "块注释未闭合（缺 `*/`）");
    }
    if (this.stack.length > 0) {
      const b = this.stack[this.stack.length - 1]!;
      this.fail(b.line, "E_BLOCK_UNCLOSED", "@if 块未闭合（缺 `}`）");
    }
    // 文件以换行结尾产生的幽灵空行不是内容（文件惯例），丢弃
    if (srcLines[srcLines.length - 1] === "" && this.lines[this.lines.length - 1]?.type === "blank") {
      this.lines.pop();
    }
    this.checkTdz();
    return { file: this.file, decls: this.decls, lines: this.lines, parent: null };
  }

  // 深度 0、引号外的 `in` 切分：取第一个 LHS 非空的（`@for in in rec {` 中变量名 `in` 不算关键字）。
  // 边界检查：`in` 前后不能是标识符字符（含 . - #，与 expr.ts 的 ident 字符集一致），
  // 否则 `user.in`、`a-in` 里的 in 不会误切。
  private splitIn(src: string, line: number): [string, string] {
    const identish = (c: string) => /[\p{L}\p{N}_\-.#]/u.test(c);
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
      if (depth === 0 && c === "i" && src[i + 1] === "n") {
        const before = i === 0 ? "" : src[i - 1]!;
        const after = src[i + 2] ?? "";
        if (!identish(before) && !identish(after) && src.slice(0, i).trim() !== "") {
          return [src.slice(0, i).trim(), src.slice(i + 2).trim()];
        }
      }
    }
    this.fail(line, "E_FOR_FORMAT", "@for 缺少 `in`（格式：@for v in expr {）");
  }

  // 顶层 `..`（范围分隔符）定位：深度 0、引号外。返回下标或 -1。
  private findTopLevelDots(src: string): number {
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
      if (c === ")" || c === "]" || c === "}") { depth--; continue; }
      if (depth === 0 && c === "." && src[i + 1] === ".") return i;
    }
    return -1;
  }

  // @for 头部解析：`变量 [， 变量] in 数据源`。返回 [变量列表, 迭代源]。
  private parseForHead(src: string, line: number): [string[], ForIterable] {
    const [lhs, rhs] = this.splitIn(src, line);
    const vars = lhs.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (vars.length === 0 || vars.length > 2) {
      this.fail(line, "E_FOR_FORMAT", "@for 变量数必须为 1 或 2（@for k, v in expr {）");
    }
    for (const v of vars) {
      if (!/^[^\s.,=(){}[\]"':?|&!<>`\\]+$/.test(v)) {
        this.fail(line, "E_FOR_FORMAT", `@for 变量名非法：${v}`);
      }
    }
    const dots = this.findTopLevelDots(rhs);
    if (dots >= 0) {
      if (vars.length > 1) this.fail(line, "E_FOR_FORMAT", "范围形式只允许 1 个循环变量（@for i in 1..5 {）");
      const fromSrc = rhs.slice(0, dots).trim();
      const toSrc = rhs.slice(dots + 2).trim();
      if (!/^\d+$/.test(fromSrc) || !/^\d+$/.test(toSrc)) {
        this.fail(line, "E_FOR_RANGE", "@for 范围边界必须是非负整数（如 @for i in 1..5 {）");
      }
      return [vars, { kind: "range", from: Number(fromSrc), to: Number(toSrc) }];
    }
    return [vars, { kind: "expr", expr: parseExpr(rhs, this.file, line) }];
  }

  // `}` 闭合当前块（close / closeElse 共用）：pop、depth--、attachTo 回写或构造节点、登记 lastClosed
  private closeBlock(line: number): void {
    if (this.stack.length === 0) this.fail(line, "E_BLOCK_STRAY", "`}` 没有对应的 @if 块");
    const b = this.stack.pop()!;
    this.depth--;
    if (b.attachTo) {
      // else 分支闭合：elseLines 附着回已发出的原始块节点（if/for，或 else-if 预置节点），不重复发节点
      const target = b.attachTo as Node & { ifLines?: Node[]; elseLines: Node[] | null };
      target.elseLines = b.elseLines;
      if (b.fillIfLines) target.ifLines = b.ifLines;   // else-if 链：回填预置 @if 节点的真分支
      this.lastClosed = { block: b.attachTo as unknown as ClosedBlock, depth: this.depth };
    } else {
      const node: Node = b.cond !== undefined
        ? { type: "block", file: this.file, line: b.line, cond: b.cond, ifLines: b.ifLines, elseLines: b.elseLines }
        : { type: "for", file: this.file, line: b.line, vars: b.vars!, iterable: b.iterable!, body: b.ifLines, elseLines: b.elseLines };
      // 偏差注：brief 原文 { block: node } —— Node 联合（for 成员无 ifLines）不可赋给 ClosedBlock（TS2322），
      // 与 attachTo 路径同款的 `as unknown as ClosedBlock` 最小转写，节点形状不变。
      this.lastClosed = { block: node as unknown as ClosedBlock, depth: this.depth };
      this.currentLines().push(node);
    }
  }

  // @else 载荷判别：`{` → null（普通 else）；`@if(…) {` → 返回 @if 之后载荷（else-if 链）；否则报错
  private attachElse(payload: string, line: number): string | null {
    if (payload === "{") return null;
    const ifM = /^@if\b\s*(.+)$/.exec(payload);
    if (ifM) return ifM[1]!;
    this.fail(line, "E_ELSE_EXPECT_BRACE",
      "@else 必须紧跟 `{`（@else {），或以 `@if(…) {` 开头（else-if 链）");
  }

  // @if 条件解析（case "if" 与 else-if 链共用）：`{` 结尾校验、剥括号解析
  private parseIfCond(payload: string, line: number): Expr {
    if (!payload.endsWith("{")) this.fail(line, "E_IF_EXPECT_BRACE", "@if 必须以 `{` 结束（@if(expr) {）");
    const exprSrc = payload.slice(0, payload.length - 1).trimEnd();
    return parseExpr(exprSrc, this.file, line);
  }

  // 开 @if 块（case "if" 用）
  private pushIf(payload: string, line: number): void {
    const cond = this.parseIfCond(payload, line);
    this.stack.push({ file: this.file, line, cond, ifLines: [], elseLines: null });
    this.depth++;
  }

  // @else 附着公共处理（case "else" 与 case "closeElse" 共用）：
  // 校验载荷 → E_ELSE_ORPHAN 检查 → 普通 else 压 attachTo 条目；else-if 链预置节点 + 压 fillIfLines 条目
  private handleElse(payload: string, line: number): void {
    const ifPayload = this.attachElse(payload, line);
    if (!this.lastClosed || this.lastClosed.depth !== this.depth || this.lastClosed.block.elseLines !== null) {
      this.fail(line, "E_ELSE_ORPHAN", "@else 没有附着的前一 @if 块（或已有 @else）");
    }
    if (ifPayload !== null) {
      // else-if 链：预创建 @if 节点直接写入前块 elseLines（即附着），压 fillIfLines 条目
      const cond = this.parseIfCond(ifPayload, line);
      const node: Node = { type: "block", file: this.file, line, cond, ifLines: [], elseLines: null };
      this.lastClosed.block.elseLines = [node];
      this.lastClosed = null;
      this.stack.push({ file: this.file, line, cond, ifLines: [], elseLines: null, attachTo: node, fillIfLines: true });
      this.depth++;
      return;
    }
    const b = this.lastClosed.block;
    this.lastClosed = null;
    this.stack.push({ file: this.file, line, cond: b.cond, ifLines: b.ifLines ?? [], elseLines: [], attachTo: b as Node });
    this.depth++;
  }

  private currentLines(): Node[] {
    if (this.stack.length > 0) {
      const b = this.stack[this.stack.length - 1]!;
      return b.elseLines ?? b.ifLines;
    }
    return this.lines;
  }

  private toParts(text: string, line: number, outerQuote: null | '"' | "'"): (string | Expr)[] {
    const parts = scanParts(text, this.file, line, outerQuote ? { outerQuote } : {});
    return parts.map((p) => ("expr" in p ? parseExpr(p.expr, this.file, line) : p.text));
  }

  private checkTdz(): void {
    for (let i = 0; i < this.decls.length; i++) {
      const d = this.decls[i]!;
      const refs = collectPathRefs(d.expr);
      for (const ref of refs) {
        const later = this.decls.findIndex((x, j) => j > i && (x.name === ref || x.name === ref.split(".")[0]));
        if (later !== -1) {
          const hit = this.decls[later]!;
          this.fail(d.line, "E_TDZ", `@set ${d.name} 引用了其后声明的 @set ${hit.name}（声明顺序：先引用后声明 → 错误）`);
        }
      }
    }
  }
}

function collectPathRefs(e: Expr): string[] {
  switch (e.kind) {
    case "path": return [e.name];
    case "literal": return [];
    case "record": return [];
    case "coalesce": return [...collectPathRefs(e.left), ...collectPathRefs(e.right)];
    case "cond": return [...collectPathRefs(e.test), ...collectPathRefs(e.yes), ...collectPathRefs(e.no)];
    case "compare": return [...collectPathRefs(e.left), ...collectPathRefs(e.right)];
    case "logical": return [...collectPathRefs(e.left), ...collectPathRefs(e.right)];
    case "not": return collectPathRefs(e.operand);
    case "index": return [...collectPathRefs(e.obj), ...collectPathRefs(e.index)];
    case "interp": return e.parts.flatMap((p) => (typeof p === "string" ? [] : collectPathRefs(p)));
  }
}

export function parseDocument(text: string, file: string): Document {
  return new DocParser(text, file).run();
}

export async function resolveIncludes(
  doc: Document,
  loadFile: LoadFile,
  stack: string[] = [],
  cache: Map<string, string> = new Map(),
): Promise<void> {
  // 统一收集 include 节点（对 block 递归、对 doc 遍历），主干与块内节点共用一条路径
  const nodes: { type: "include"; file: string; line: number; path: string; doc: Document | null }[] = [];
  collectIncludes(doc.lines, nodes);
  for (const node of nodes) {
    if (node.doc) continue;
    if (!doc.file) {
      throw psError("parse", node.file, node.line, "E_SYNTAX",
        "匿名文档（无文件路径）无法解析相对 include 路径；请用 PromptScript.load 或提供文件路径");
    }
    const resolved = resolveIncludePath(doc.file, node.path);
    if (stack.includes(resolved)) {
      throw psError("load", node.file, node.line, "E_INCLUDE_CYCLE", `include 循环：${[...stack, resolved].join(" → ")}`);
    }
    let text: string;
    if (cache.has(resolved)) {
      // 命中：同一 resolve 内同一路径只读一次磁盘（loadFile 约定对同一路径返回确定内容，以首次为准）
      text = cache.get(resolved)!;
    } else {
      try {
        text = await loadFile(resolved);
      } catch (e) {
        throw psError("load", node.file, node.line, "E_INCLUDE_MISSING",
          `加载失败 ${resolved}：${e instanceof Error ? e.message : String(e)}`);
      }
      cache.set(resolved, text);
    }
    const child = parseDocument(text, resolved);
    child.parent = doc;
    dedent(child);
    node.doc = child;
    await resolveIncludes(child, loadFile, [...stack, resolved], cache);
  }
}

function collectIncludes(lines: Node[], out: { type: "include"; file: string; line: number; path: string; doc: Document | null }[]): void {
  for (const l of lines) {
    if (l.type === "include") out.push(l);
    else if (l.type === "block") {
      collectIncludes(l.ifLines, out);
      if (l.elseLines) collectIncludes(l.elseLines, out);
    } else if (l.type === "for") {
      collectIncludes(l.body, out);
      if (l.elseLines) collectIncludes(l.elseLines, out);
    }
  }
}

function dedent(doc: Document): void {
  let min: number | null = null;
  for (const l of doc.lines) {
    if (l.type === "raw") {
      const first = l.parts[0];
      const indent = typeof first === "string" ? /^[ \t]*/.exec(first)![0].length : 0;
      min = min === null ? indent : Math.min(min, indent);
    }
  }
  if (min === null || min === 0) return;
  for (const l of doc.lines) {
    if (l.type === "raw" && typeof l.parts[0] === "string") {
      l.parts[0] = (l.parts[0] as string).slice(min);
    }
  }
}
