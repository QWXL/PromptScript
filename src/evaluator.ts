import type { Expr, Pos } from "./ast.js";
import type { Document, Decl, Node } from "./parser.js";
import { psError } from "./errors.js";

// 偏差注：brief 原文 Record<string, PSValue> 在 tsc 5.9 报 TS2456（类型别名直接自环）——
// 改用字面索引签名形式（等价语义，与规范文档 PSValue: Record<string, Primitive> 一致）
export type PSValue = string | number | boolean | null | undefined | { [key: string]: PSValue };

// @for 单次迭代上限（防失控大循环；对任何现实模板足够，超限快速失败）
export const MAX_FOR_ITERATIONS = 32768;

/** JSON 等外部来源 → PSValue 的收窄转换：数组/函数/非纯对象等非 PSValue 结构 → E_TYPE */
export function parseToPSValue(v: unknown, ctx: string): PSValue {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "undefined") return undefined;
  if (Array.isArray(v)) throw psError("render", "", 0, "E_TYPE", `${ctx} 是数组——PSValue 不支持数组`);
  const proto = Object.getPrototypeOf(v);
  if (typeof v === "object" && (proto === Object.prototype || proto === null)) {
    const rec: Record<string, PSValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) rec[k] = parseToPSValue(val, `${ctx}.${k}`);
    return rec;
  }
  throw psError("render", "", 0, "E_TYPE", `${ctx} 的类型 ${typeof v} 不是 PSValue`);
}

const MISS = Symbol("ps-miss");
type Result = { found: true; value: PSValue } | { found: false };

interface Frame {
  parent: Frame | null;
  doc: Document;
  bindings: Map<string, PSValue>;
}

export function renderDocument(doc: Document, injections: Record<string, PSValue>): string {
  const root = buildFrame(doc, null, injections);
  const out = renderLines(doc.lines, root);
  return out.join("\n");
}

function buildFrame(doc: Document, parent: Frame | null, injections: Record<string, PSValue> | null): Frame {
  const bindings = new Map<string, PSValue>();
  if (injections) {
    for (const [k, v] of Object.entries(injections)) {
      if (doc.decls.some((d) => d.name === k)) {
        throw psError("render", doc.file, 0, "E_INJECT_CONFLICT", `注入名 ${k} 与根帧 @set 声明冲突`);
      }
      bindings.set(k, v);
    }
  }
  const frame: Frame = { parent, doc, bindings };
  for (const d of doc.decls) {
    // 偏差注：brief 代码块用 v as PSValue 把 MISS 存入绑定（惰性，引用点才报错）——与规范空缺矩阵
    // "@set 未绑定 → 帧求值即爆" 冲突（@set x = missing 且 x 永不被引用会静默通过）。按规范：求值即爆，
    // ?? 兜底在 evalExpr 内部先于此处完成（左 MISS → 右值，故不误报）。
    const v = evalExpr(d.expr, frame, d.file, d.line);
    if (v === MISS) {
      throw psError("render", d.file, d.line, "E_UNBOUND",
        `@set ${d.name} 引用了未绑定的名字（帧求值即爆）`);
    }
    bindings.set(d.name, v);
  }
  return frame;
}

function lookup(frame: Frame, name: string): Result {
  for (let f: Frame | null = frame; f; f = f.parent) {
    // 用 has() 而非 !== undefined：注入值可能显式为 undefined（软空缺），键存在即命中
    if (f.bindings.has(name)) return { found: true, value: f.bindings.get(name) };
  }
  const first = name.split(".")[0]!;
  let base: Result = { found: false };
  for (let f: Frame | null = frame; f; f = f.parent) {
    if (f.bindings.has(first)) { base = { found: true, value: f.bindings.get(first) }; break; }
  }
  if (!base.found) return { found: false };
  let v = base.value;
  const rest = name.slice(first.length + (name.startsWith(first + ".") ? 1 : 0));
  if (rest === "") return base;
  const segs = rest.split(".");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) {
      return { found: false }; // 非记录 → 视为不可遍历
    }
    // 原型链穿透防御（fix 1）：仅自有属性可解析——继承成员（constructor/toString/__proto__…）视为未绑定
    if (!Object.hasOwn(v, seg)) return { found: false };
    v = (v as Record<string, PSValue>)[seg];
    // 中间段为函数 → 不可继续遍历（视为未绑定）；末段函数值交由 renderParts 的 E_RECORD_RENDER 兜底
    if (typeof v === "function" && i < segs.length - 1) return { found: false };
  }
  return { found: true, value: v };
}

function evalExpr(e: Expr, frame: Frame, file: string, line: number): PSValue | typeof MISS {
  switch (e.kind) {
    case "path": {
      const r = lookup(frame, e.name);
      return r.found ? r.value : MISS;
    }
    case "literal": return e.value;
    case "record": {
      const rec: Record<string, PSValue> = {};
      for (const [k, v] of e.entries) rec[k] = v;
      return rec;
    }
    case "coalesce": {
      const l = evalExpr(e.left, frame, file, line);
      if (l === MISS || l === null || l === undefined) return evalExpr(e.right, frame, file, line);
      return l;
    }
    case "cond": {
      const t = evalExpr(e.test, frame, file, line);
      if (t === MISS) throw psError("render", file, line, "E_UNBOUND", "条件表达式引用了未绑定的名字");
      return truthy(t) ? evalExpr(e.yes, frame, file, line) : evalExpr(e.no, frame, file, line);
    }
    case "compare": {
      const l = evalExpr(e.left, frame, file, line);
      const r = evalExpr(e.right, frame, file, line);
      if (l === MISS || r === MISS) {
        // 偏差注：brief 代码对 MISS 操作数做空值等价（==）或静默 false（</>）——与规范空缺矩阵
        // "未绑定名被使用 → E_UNBOUND（硬空缺）" 冲突；空值等价只适用于已绑定的 null/undefined。
        throw psError("render", file, line, "E_UNBOUND",
          "比较操作数引用了未绑定的名字");
      }
      if (e.op === "<" || e.op === ">") {
        if (typeof l !== "number" || typeof r !== "number") {
          throw psError("render", file, line, "E_TYPE", `比较 ${e.op} 仅支持数字（得到 ${typeof l} 与 ${typeof r}）`);
        }
        return e.op === "<" ? l < r : l > r;
      }
      return evalCompare(e.op, l, r);
    }
    case "logical": {
      const l = evalExpr(e.left, frame, file, line);
      // fix 5：谓词无回退概念——左 MISS 直接上抛（与 && 对齐）；|| 不再吞 MISS 去求值右值
      if (l === MISS) return MISS;
      if (e.op === "&&") return truthy(l) ? evalExpr(e.right, frame, file, line) : false;
      return truthy(l) ? l : evalExpr(e.right, frame, file, line);
    }
    case "not": {
      const v = evalExpr(e.operand, frame, file, line);
      if (v === MISS) throw psError("render", file, line, "E_UNBOUND", "! 操作数引用了未绑定的名字");
      return !truthy(v);
    }
    case "index": {
      const obj = evalExpr(e.obj, frame, file, line);
      if (obj === MISS) return MISS;
      if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw psError("render", file, line, "E_TYPE", "下标访问的目标不是记录");
      }
      const key = evalExpr(e.index, frame, file, line);
      // 偏差注：brief 原文对 MISS key 抛 E_UNBOUND，与 brief 自身用例（R(text, {}) → "未知"）及
      // "MISS 传播"语义矛盾——下标键未绑定 → 整式 MISS 传播，由外层 ?? 兜底或槽位/谓词报硬空缺
      if (key === MISS) return MISS;
      const k = String(key);
      // 原型链穿透防御（fix 1）：仅自有属性可索引。非自有键 → MISS（硬空缺，与路径遍历缺失段
      // {r.missing} → E_UNBOUND 语义对齐）。
      // 偏差注：review 处方原文为"非自有 → return undefined（软空缺）"，与处方测试
      // {r["toString"]} → E_UNBOUND 直接矛盾；按测试实现（coalesce 兜底不受影响——MISS 同样触发回退）。
      if (!Object.hasOwn(obj, k)) return MISS;
      return (obj as Record<string, PSValue>)[k] ?? undefined;
    }
  }
}

function evalCompare(op: "==" | "!=", l: PSValue | typeof MISS, r: PSValue | typeof MISS): boolean {
  const empty = (v: PSValue | typeof MISS) => v === MISS || v === null || v === undefined;
  if (empty(l) || empty(r)) return op === "==" ? empty(l) && empty(r) : !(empty(l) && empty(r));
  const equal = l === r || (typeof l === "object" && typeof r === "object" && deepEqual(l, r));
  return op === "==" ? equal : !equal;
}

// 深度比较（替换 JSON.stringify 深比较：键序无关、undefined 值键参与比较、循环/深度护栏）
const DEEP_EQUAL_MAX_DEPTH = 100;

function deepEqual(a: PSValue, b: PSValue, depth = 0): boolean {
  if (a === b) return true;
  if (depth > DEEP_EQUAL_MAX_DEPTH) return false; // host 注入对象可能成环——JSON.stringify 时代抛 TypeError，这里返回不等
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]!, depth + 1));
  }
  const plain = (v: object) => {
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  };
  if (!plain(a) || !plain(b)) return false; // 非纯对象（Date/Map…）仅引用相等
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k], depth + 1));
}

function truthy(v: PSValue | typeof MISS): boolean {
  if (v === MISS || v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return true; // 记录 truthy
}

// @for 迭代源解析：范围 → [k, v] 对（k 为字符串化下标，v 为数字计数器）；表达式 → 记录条目。
// 先算总数再循环，超上限 E_FOR_LIMIT。
function resolveIterable(n: Node & { type: "for" }, frame: Frame): [string, PSValue][] {
  if (n.iterable.kind === "range") {
    const { from, to } = n.iterable;
    const count = to >= from ? to - from + 1 : 0;
    if (count > MAX_FOR_ITERATIONS) {
      throw psError("render", n.file, n.line, "E_FOR_LIMIT",
        `@for 迭代次数 ${count} 超过上限 ${MAX_FOR_ITERATIONS}`);
    }
    const items: [string, PSValue][] = [];
    for (let i = from; i <= to; i++) items.push([String(i), i]);
    return items;
  }
  const v = evalExpr(n.iterable.expr, frame, n.file, n.line);
  if (v === MISS) throw psError("render", n.file, n.line, "E_UNBOUND", "@for 数据源引用了未绑定的名字");
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) {
    throw psError("render", n.file, n.line, "E_TYPE", "@for 数据源必须是记录（得到非记录值）");
  }
  const entries = Object.entries(v as Record<string, PSValue>);
  if (entries.length > MAX_FOR_ITERATIONS) {
    throw psError("render", n.file, n.line, "E_FOR_LIMIT",
      `@for 迭代次数 ${entries.length} 超过上限 ${MAX_FOR_ITERATIONS}`);
  }
  return entries;
}

function renderLines(lines: Node[], frame: Frame): string[] {
  const out: string[] = [];
  for (const n of lines) {
    switch (n.type) {
      case "blank":
        out.push("");
        break;
      case "raw": {
        out.push(renderParts(n.parts, frame, n.file, n.line));
        break;
      }
      case "literal": {
        out.push(renderParts(n.parts, frame, n.file, n.line));
        break;
      }
      case "block": {
        const t = evalExpr(n.cond, frame, n.file, n.line);
        if (t === MISS) throw psError("render", n.file, n.line, "E_UNBOUND", "@if 谓词引用了未绑定的名字");
        out.push(...renderLines(truthy(t) ? n.ifLines : n.elseLines ?? [], frame));
        break;
      }
      case "for": {
        const items = resolveIterable(n, frame);
        // 偏差注：brief 原文在 case 块内 `const out` 遮蔽 renderLines 外层累加器且从未合并——
        // for 循环体输出被整体丢弃（Step 2 后 7 个用例仍 FAIL，全部是期望有输出的用例）。
        // 改为 bodyOut 收集、最后并入外层 out（brief 自身测试即要求此语义）。
        const bodyOut: string[] = [];
        for (const [k, v] of items) {
          // 子帧方案：每次迭代新建绑定帧（与 include 子帧同构），循环变量遮蔽外层，循环外自动恢复
          const child: Frame = { parent: frame, doc: frame.doc, bindings: new Map() };
          if (n.vars.length === 2) child.bindings.set(n.vars[0]!, k);   // 键
          child.bindings.set(n.vars[n.vars.length - 1]!, v);            // 值 / 计数器
          bodyOut.push(...renderLines(n.body, child));
        }
        if (bodyOut.length === 0 && n.elseLines) bodyOut.push(...renderLines(n.elseLines, frame));
        out.push(...bodyOut);
        break;
      }
      case "include": {
        if (!n.doc) throw psError("render", n.file, n.line, "E_UNRESOLVED", "include 尚未解析：请先 await ps.resolve()");
        const child = buildFrame(n.doc, frame, null);
        out.push(...renderLines(n.doc.lines, child));
        break;
      }
    }
  }
  return out;
}

function renderParts(parts: (string | Expr)[], frame: Frame, file: string, line: number): string {
  let s = "";
  for (const p of parts) {
    if (typeof p === "string") { s += p; continue; }
    const v = evalExpr(p, frame, file, line);
    if (v === MISS) throw psError("render", file, line, "E_UNBOUND", "槽位引用了未绑定的名字（如需回退请用 ?? / |）");
    if (v === undefined || v === null) continue;
    if (typeof v === "function") throw psError("render", file, line, "E_RECORD_RENDER", "不能直接渲染函数值/记录值");
    if (typeof v === "object") throw psError("render", file, line, "E_RECORD_RENDER", "不能直接渲染记录值（请用下标/点访问取字段）");
    s += String(v);
  }
  return s;
}

// ─── collectMissing ───
export function collectMissing(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const resolvable = (d: Document | null, name: string): boolean => {
    const first = name.split(".")[0]!;
    for (let f: Document | null = d; f; f = f.parent) {
      if (f.decls.some((x) => x.name === name || x.name === first)) return true;
    }
    return false;
  };
  const walkExpr = (e: Expr, d: Document, bound: Set<string>) => {
    switch (e.kind) {
      case "path": {
        const root = e.name.split(".")[0]!;
        if (!bound.has(root) && !resolvable(d, e.name) && !seen.has(e.name)) { seen.add(e.name); out.push(e.name); }
        return;
      }
      case "coalesce": walkExpr(e.left, d, bound); walkExpr(e.right, d, bound); return;
      case "cond": walkExpr(e.test, d, bound); walkExpr(e.yes, d, bound); walkExpr(e.no, d, bound); return;
      case "compare": walkExpr(e.left, d, bound); walkExpr(e.right, d, bound); return;
      case "logical": walkExpr(e.left, d, bound); walkExpr(e.right, d, bound); return;
      case "not": walkExpr(e.operand, d, bound); return;
      case "index": walkExpr(e.obj, d, bound); walkExpr(e.index, d, bound); return;
      case "literal": case "record": return;
    }
  };
  const walkDoc = (d: Document, bound: Set<string> = new Set()) => {
    for (const decl of d.decls) walkExpr(decl.expr, d, bound);
    for (const n of d.lines) walkNode(n, d, bound);
  };
  const walkNode = (n: Node, d: Document, bound: Set<string>) => {
    switch (n.type) {
      case "raw": case "literal":
        for (const p of n.parts) if (typeof p !== "string") walkExpr(p, d, bound);
        break;
      case "block":
        walkExpr(n.cond, d, bound);
        for (const l of n.ifLines) walkNode(l, d, bound);
        if (n.elseLines) for (const l of n.elseLines) walkNode(l, d, bound);
        break;
      case "for": {
        if (n.iterable.kind === "expr") walkExpr(n.iterable.expr, d, bound);
        const inner = new Set(bound);
        for (const v of n.vars) inner.add(v);
        for (const l of n.body) walkNode(l, d, inner);
        if (n.elseLines) for (const l of n.elseLines) walkNode(l, d, bound);
        break;
      }
      case "include":
        if (n.doc) walkDoc(n.doc, bound);   // boundVars 穿透子文档：循环变量经 include 不误报
        break;
      case "blank": break;
    }
  };
  walkDoc(doc);
  return out;
}
