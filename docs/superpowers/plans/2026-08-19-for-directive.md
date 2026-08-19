# @for 指令实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PromptScript 语言新增 `@for` 循环指令（记录条目迭代 + 整数范围迭代），并配套 include 读取缓存。

**Architecture:** `@for` 是新的指令行，解析期构造 `for` AST 节点（复用现有块栈的 `}` 闭合与 `@else` 附着机制）；渲染期每次迭代创建子帧绑定循环变量（与 include 子帧同构）；`collectIncludes` / `anyNode` / `collectMissing` 三个树遍历扩展支持新节点；`resolveIncludes` 增加按路径的文本缓存。

**Tech Stack:** TypeScript（Node ≥ 22）、Vitest。无新依赖。

## Global Constraints

- 规格文档：`docs/superpowers/specs/2026-08-19-for-directive-design.md`（本计划的唯一行为契约，冲突时以规格为准）。
- **无 git 仓库**（promptscript 目录及上层均不是 git 仓库）——所有 commit 步骤改为运行测试确认，不执行 git 命令。
- 测试命令：`npx vitest run test/<file>.test.ts`（单文件）或 `npm test`（全量）。
- 新错误码（错误消息直接面向作者，带 `file:line`）：
  - `E_FOR_FORMAT`（解析）：缺 `in`、变量数 0 或 >2、变量名非法、范围形式变量数 >1。
  - `E_FOR_EXPECT_BRACE`（解析）：`@for` 行不以 `{` 结尾。
  - `E_FOR_RANGE`（解析）：范围边界不是非负整数（小数、负数、路径表达式）。
  - `E_FOR_LIMIT`（渲染）：单次迭代 > 32768。
- 上限常量：`export const MAX_FOR_ITERATIONS = 32768;`（evaluator.ts）。
- 数组仍然不支持：`parseToPSValue` 不动；数据源是数组 → `E_TYPE`。
- CLI 无需改动（render/check 走同一解析/求值管线）。

---

### Task 1: 词法识别 `@for` 指令

**Files:**
- Modify: `src/lexer.ts:4`
- Test: `test/lexer.test.ts`

**Interfaces:**
- Consumes: 无（独立小改）。
- Produces: `scanLine("@for …")` 返回 `{ kind: "directive", directive: "for", payload: … }`——Task 2 解析器依赖。

- [ ] **Step 1: 写失败测试**

在 `test/lexer.test.ts` 的 "directive：已知指令，payload 截取" 测试中追加断言，并新建一个 `@for` 用例：

```ts
test("directive：@for 识别 + payload 截取", () => {
  expect(scanLine("@for v in tags {", 1, "article").directive).toBe("for");
  expect(scanLine("@for v in tags {", 1, "article").payload).toBe("v in tags {");
  expect(scanLine("@for k, v in tags {", 1, "code").directive).toBe("for");
  expect(scanLine("@for i in 1..5 {", 1, "code").directive).toBe("for");
});
```

在 "unknown directive" 测试中追加：

```ts
err(() => scanLine("@forx", 1, "article"), "E_UNKNOWN_DIRECTIVE");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/lexer.test.ts`
Expected: 新测试 FAIL（`scanLine("@for …")` 抛 `E_UNKNOWN_DIRECTIVE`，`.directive` 为 `undefined`）。

- [ ] **Step 3: 实现**

`src/lexer.ts:4`：

```ts
export const DIRECTIVES = ["set", "if", "else", "include", "for"] as const;
```

`E_UNKNOWN_DIRECTIVE` 的已知指令提示字符串由 `DIRECTIVES.join("/")` 生成，自动带上 `for`，无需改消息。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/lexer.test.ts`
Expected: PASS。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 1 完成）。

---

### Task 2: AST 节点 + 解析器（含 `collectIncludes` / `anyNode` 扩展）

**Files:**
- Modify: `src/parser.ts`（Node 联合类型、DocParser 块栈、case "for"、"close"、"else"、collectIncludes）
- Modify: `src/index.ts:14-17`（anyNode）
- Test: `test/parser.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `scanLine`（directive: "for"）；现有 `parseExpr`（`src/expr.ts`）。
- Produces:
  - `export type ForIterable = { kind: "range"; from: number; to: number } | { kind: "expr"; expr: Expr };`
  - Node 联合类型新增：`{ type: "for"; file: string; line: number; vars: string[]; iterable: ForIterable; body: Node[]; elseLines: Node[] | null }`——Task 3/4 依赖。
  - `collectIncludes` 递归 for 节点 body/elseLines——Task 5 依赖（循环内 include 才被加载）。

- [ ] **Step 1: 写失败测试**

在 `test/parser.test.ts` 末尾新增 describe（复用文件顶部 `err` helper）：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/parser.test.ts`
Expected: 新测试 FAIL（`E_UNKNOWN_DIRECTIVE` 或 "TypeError: Cannot read properties of undefined"——for 节点不存在）。

- [ ] **Step 3: 实现**

`src/parser.ts` 三处修改：

**(a) Node 联合类型（第 9-14 行区域）**：

```ts
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
```

**(b) DocParser 类：块栈条目泛化 + 私有辅助方法（第 44-46 行区域及 `case "if"` 之后）**：

```ts
interface BlockEntry {
  file: string; line: number;
  cond?: Expr; iterable?: ForIterable; vars?: string[];
  ifLines: Node[]; elseLines: Node[] | null; attachTo?: Node;
}
interface ClosedBlock { cond?: Expr; iterable?: ForIterable; vars?: string[]; ifLines: Node[]; elseLines: Node[] | null }
```

替换第 44-46 行的栈与 lastClosed 声明：

```ts
  private stack: BlockEntry[] = [];
  private lastClosed: { block: ClosedBlock; depth: number } | null = null;
```

`case "if"` 的 push（原第 114 行 `this.stack.push({ file: this.file, line: i + 1, cond, ifLines: [], elseLines: null });`）与 `case "else"` 的 push（原第 127-135 行）类型不变，仍合法（cond/iterable 均变为可选）。`case "else"` 中 `ifLines: b.ifLines` 改为 `ifLines: b.ifLines ?? []`（for 节点无 ifLines，attachTo 路径不使用它，补 `?? []` 满足类型）。

`case "close"`（原第 79-96 行）替换为：

```ts
        case "close": {
          if (this.stack.length === 0) this.fail(i + 1, "E_BLOCK_STRAY", "`}` 没有对应的 @if 块");
          const b = this.stack.pop()!;
          this.depth--;
          if (b.attachTo) {
            // else 分支闭合：elseLines 附着回已发出的原始块节点（if 或 for），不重复发节点
            (b.attachTo as Node & { elseLines: Node[] | null }).elseLines = b.elseLines;
            this.lastClosed = { block: b.attachTo as unknown as ClosedBlock, depth: this.depth };
          } else {
            const node: Node = b.cond !== undefined
              ? { type: "block", file: this.file, line: b.line, cond: b.cond, ifLines: b.ifLines, elseLines: b.elseLines }
              : { type: "for", file: this.file, line: b.line, vars: b.vars!, iterable: b.iterable!, body: b.ifLines, elseLines: b.elseLines };
            this.lastClosed = { block: node, depth: this.depth };
            this.currentLines().push(node);
          }
          break;
        }
```

`case "directive"` 的 switch 中 `case "include"` 之后新增 `case "for"`：

```ts
            case "for": {
              const payload = scanned.payload ?? "";
              if (!payload.endsWith("{")) this.fail(i + 1, "E_FOR_EXPECT_BRACE", "@for 必须以 `{` 结束（@for v in expr {）");
              const inner = payload.slice(0, payload.length - 1).trimEnd();
              const [vars, iterable] = this.parseForHead(inner, i + 1);
              this.stack.push({ file: this.file, line: i + 1, vars, iterable, ifLines: [], elseLines: null });
              this.depth++;
              break;
            }
```

类内新增两个私有方法（放在 `currentLines()` 之前）：

```ts
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
```

**(c) collectIncludes 扩展（第 260-268 行）**：

```ts
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
```

`src/index.ts` 的 `anyNode`（第 14-17 行）扩展（循环体内 include 触发 E_INCLUDE_NO_LOADER / E_UNRESOLVED 守卫）：

```ts
function anyNode(lines: Node[], test: (n: Node) => boolean): boolean {
  return lines.some((n) =>
    test(n) ||
    (n.type === "block" && (anyNode(n.ifLines, test) || anyNode(n.elseLines ?? [], test))) ||
    (n.type === "for" && (anyNode(n.body, test) || anyNode(n.elseLines ?? [], test))));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/parser.test.ts`
Expected: PASS（含既有测试——块配对、@else 附着、include 等回归）。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 2 完成）。

---

### Task 3: 求值器 for 渲染 + 迭代上限

**Files:**
- Modify: `src/evaluator.ts`（`MAX_FOR_ITERATIONS` 常量、`resolveIterable`、`renderLines` case "for"）
- Test: `test/evaluator.test.ts`

**Interfaces:**
- Consumes: Task 2 的 Node `type: "for"`（`vars: string[]`、`iterable: ForIterable`、`body`、`elseLines`）；现有 `evalExpr` / `MISS` / `Frame` / `renderLines`。
- Produces: `export const MAX_FOR_ITERATIONS = 32768`（Task 3 测试与文档使用）。

- [ ] **Step 1: 写失败测试**

在 `test/evaluator.test.ts` 末尾新增 describe（复用文件顶部 `R` / `err` helper）：

```ts
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
    const text = '@set name = "全局"\n@for name in tags {\n  "{name}"\n}\n"{name}"\n';
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/evaluator.test.ts`
Expected: 新测试 FAIL（`renderLines` 对 `type: "for"` 无 case——现有 switch 无 default，for 节点静默不渲染 → 输出为空串）。

- [ ] **Step 3: 实现**

`src/evaluator.ts` 三处修改：

**(a) 常量（第 8 行 PSValue 之后）**：

```ts
// @for 单次迭代上限（防失控大循环；对任何现实模板足够，超限快速失败）
export const MAX_FOR_ITERATIONS = 32768;
```

**(b) 新增 `resolveIterable`（放在 `renderLines` 之前）**：

```ts
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
```

**(c) `renderLines` 的 switch 中 `case "include"` 之前新增 `case "for"`**：

```ts
      case "for": {
        const items = resolveIterable(n, frame);
        const out: string[] = [];
        for (const [k, v] of items) {
          // 子帧方案：每次迭代新建绑定帧（与 include 子帧同构），循环变量遮蔽外层，循环外自动恢复
          const child: Frame = { parent: frame, doc: frame.doc, bindings: new Map() };
          if (n.vars.length === 2) child.bindings.set(n.vars[0]!, k);   // 键
          child.bindings.set(n.vars[n.vars.length - 1]!, v);            // 值 / 计数器
          out.push(...renderLines(n.body, child));
        }
        if (out.length === 0 && n.elseLines) out.push(...renderLines(n.elseLines, frame));
        break;
      }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/evaluator.test.ts`
Expected: PASS（含既有测试——空缺矩阵、include 子帧等回归）。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 3 完成）。

---

### Task 4: collectMissing 支持 @for（含 include 穿透）

**Files:**
- Modify: `src/evaluator.ts`（collectMissing：walkExpr / walkDoc / walkNode 加 boundVars 上下文）
- Test: `test/evaluator.test.ts`

**Interfaces:**
- Consumes: Task 2 的 for 节点、Task 3 之后无依赖。
- Produces: `collectMissing` 对含 @for 的文档返回正确结果（循环变量不误报）。

- [ ] **Step 1: 写失败测试**

在 `test/evaluator.test.ts` 的 "collectMissing" describe 内追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/evaluator.test.ts`
Expected: 新测试 FAIL（循环变量 `v` 被当作未绑定收集；`v.x` 也报）。

- [ ] **Step 3: 实现**

`src/evaluator.ts` 的 collectMissing 内部三个函数整体替换（第 257-291 行区域）：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/evaluator.test.ts`
Expected: PASS（含既有 collectMissing 测试——`["y", "a", "b.c", "d"]`、`["v", "zzz"]` 等回归）。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 4 完成）。

---

### Task 5: include 读取缓存（按路径，一次 resolve 内只读一次盘）

**Files:**
- Modify: `src/parser.ts`（`resolveIncludes` 签名 + 读盘分支）
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 collectIncludes（循环内 include 节点进入收集列表）。
- Produces: `resolveIncludes(doc, loadFile, stack?, cache?)`——第 4 个参数 `cache: Map<string, string>`（解析后路径 → 文本），顶层默认新建、递归透传。渲染期无 IO（`node.doc` 复用）。

- [ ] **Step 1: 写失败测试**

在 `test/index.test.ts` 末尾追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/index.test.ts`
Expected: 新测试 FAIL（`calls` 为 3——frag 被两个节点各读一次）。

- [ ] **Step 3: 实现**

`src/parser.ts` 的 `resolveIncludes`（第 227-258 行）：

```ts
export async function resolveIncludes(
  doc: Document,
  loadFile: LoadFile,
  stack: string[] = [],
  cache: Map<string, string> = new Map(),
): Promise<void> {
```

读盘分支（原第 245-251 行）替换为：

```ts
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
```

递归调用（原第 256 行）追加第 4 个参数：

```ts
    await resolveIncludes(child, loadFile, [...stack, resolved], cache);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/index.test.ts`
Expected: PASS（含既有 API 测试回归——load/render/守卫等）。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 5 完成）。

---

### Task 6: 语法高亮（tmLanguage）加 `for`

**Files:**
- Modify: `syntaxes/promptscript.tmLanguage.json`（三处）
- Test: `test/grammar.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: 高亮文件含 `@for` 关键词（VSCode 扩展侧按仓库约定 sync-grammar 再打包）。

- [ ] **Step 1: 写失败测试**

`test/grammar.test.ts` 的 "指令关键字齐全" 测试：

```ts
  test("指令关键字齐全", () => {
    const s = JSON.stringify(grammar);
    for (const kw of ["@set", "@if", "@else", "@include", "@for"]) expect(s).toContain(kw);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/grammar.test.ts`
Expected: FAIL（`s` 不含 `@for` 字面量）。

- [ ] **Step 3: 实现**

`syntaxes/promptscript.tmLanguage.json` 三处：

**(a)** comments 段 `@` 行 pattern（原约第 85 行）：

```json
"match": "(?<=^@)(set|if|else|include|for)\\b",
```

**(b)** comments 段 `}` 行 pattern（原约第 111 行）：

```json
"match": "@(set|if|else|include|for)\\b",
```

**(c)** directives 段新增 pattern（`@include` 条目之后）：

```json
        {
          "match": "\\s*@for\\b",
          "name": "keyword.control.promptscript"
        },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/grammar.test.ts`
Expected: PASS。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 6 完成）。

---

### Task 7: 文档（docs/LANGUAGE.md）

**Files:**
- Modify: `docs/LANGUAGE.md`
- Test: 无新测试（纯文档；以 markdown 可读性人工核对）

**Interfaces:**
- Consumes: 以上全部任务的最终行为。
- Produces: 语言规范与实现一致（规范是随包发布的行为契约）。

- [ ] **Step 1: 更新 §2.1 行类型表**

指令行判定规则列（第 24 行）追加 `@for`：

```markdown
| 指令行 | 以已知指令名开头（`@set`、`@if`、`@else`、`@include`、`@for`） | `@set n = e`、`@if(e) {`、`@else {`、`@include("path")`、`@for v in rec {` | 驱动结构或绑定，不渲染本体 |
```

- [ ] **Step 2: 更新 §2.2：`@include` 追加缓存说明 + 新增 `@for` 小节**

`@include` 小节末尾追加：

```markdown
- **读取缓存**：同一加载（resolve）过程中，同一路径只读取一次磁盘；多个 `@include` 引用同一文件（如顶层与循环体内各一处）共享缓存文本，但各自解析为独立子帧。
```

`@include` 小节之后新增：

```markdown
#### `@for 变量[， 变量] in 数据源 { … }` / `@else { … }`

循环渲染块。

- **形式**：
  - `@for v in 记录表达式 {`：`v` 绑定每条**值**（如 `@for v in vip_label {`）。
  - `@for k, v in 记录表达式 {`：`k` 绑定**键**、`v` 绑定**值**。
  - `@for i in 1..5 {`：整数范围，闭区间 `[1, 5]` 共 5 次，`i` 绑定计数器（非负整数，不支持负数/小数/步长）。
- **语法**：`@for` 行必须以 `{` 结尾、`}` 独占一行闭合（与 `@if` 一致）；`@else` 附着规则与 `@if` 相同；块内采用代码模式；支持嵌套 `@for`；`@for` 可在顶层或 `@if` 块内出现。
- **空迭代**：空记录或 `start > end` 时渲染 `@else` 分支（若有），否则不渲染。
- **作用域**：循环体是隐式子帧；循环变量临时遮蔽外层同名绑定（宿主注入、`@set`、外层循环变量），循环外恢复。循环变量不进帧级声明表（无重名检查、无 TDZ）。
- **空缺**：数据源引用未绑定名 → 渲染期 `E_UNBOUND`（与 `@if` 谓词一致）；循环体内沿用现有空缺矩阵规则。
- **范围是 `@for` 局部语法**：`1..5` 不是通用表达式（`@set x = 1..5` 仍是语法错误），仅在 `@for` 指令内识别。
- **循环内 `@include`**：允许；被包含文件以当前迭代的子帧为父帧，可直接引用循环变量；被包含文件内的 `@set` 与循环变量同名时静默遮蔽循环变量。空迭代时循环体不执行。
- **迭代上限**：单次 `@for` 迭代超过 32768 次 → 渲染期 `E_FOR_LIMIT` 错误（防失控大循环；上限按单个 `@for` 计）。

示例：

```promptscript
@set vip_label = {"svip": "超级会员", "free": "免费会员"}

@for v in vip_label {
  "- {v}"
}
@for k, v in vip_label {
  "- {k}：{v}"
}
@for i in 1..3 {
  "第 {i} 段："
  "正文内容"
}
@for k, v in vip_label ?? {} {
  "- {k}：{v}"
}
@else {
  "暂无会员标签"
}
```

（注意：文档里的 `@for` 示例代码块是嵌套 markdown 代码块，写文档时保持内部代码块缩进 4 空格。）

```

> 实现者注意：上述 `@for` 示例代码块在最终文档中应写为缩进 4 空格的嵌套代码块（本计划的代码块内不能嵌套代码块标记）。

- [ ] **Step 3: 更新 §2.3「暂不支持」与 §3.3 静态规则表**

§2.3 暂不支持列表（第 156 行）末尾追加：

```markdown
`..` 范围语法（仅 `@for` 指令内可用）、`in` 关键字（仅 `@for` 指令内识别）。
```

§3.3 静态规则表末尾追加一行：

```markdown
| `@for` 循环变量（块级）   | 无（静默遮蔽外层同名绑定；不进帧级声明表） |
```

- [ ] **Step 4: 更新 §4.2 求值次序、§4.3 错误分层、§5 边界**

§4.2 第 3 条（第 282 行）替换为：

```markdown
3. **渲染**：深度遍历 AST，逐层求值 `@if`/`@else` 真值栈；`@for` 在节点处创建每次迭代的子帧并递归渲染循环体；include 子帧在对应语句处求值。
```

§4.3 错误分层（第 287-291 行）：

```markdown
| 阶段   | 错误                                                      |
| ------ | --------------------------------------------------------- |
| 解析期 | 语法错误、`@set` 非顶层、同帧重名、TDZ 顺序错误、`@for` 格式错误（E_FOR_FORMAT / E_FOR_EXPECT_BRACE / E_FOR_RANGE） |
| 加载期 | include 文件缺失、include 循环引用                        |
| 渲染期 | 注入名冲突、`@set` 引用未绑定名、槽位硬空缺、直接渲染记录、`@for` 迭代超上限（E_FOR_LIMIT） |
```

§5 边界列表末尾追加：

```markdown
13. **`@for` 块**：`@for` 行必须以 `{` 结尾、`}` 独占一行闭合；`@else` 附着规则与 `@if` 相同；空迭代走 `@else`。
14. **`@for` 迭代上限**：32768 次（按单个 `@for` 计），超限渲染期报 `E_FOR_LIMIT`。
15. **`@for` 范围**：非负整数闭区间；`start > end` 为空迭代；范围语法仅 `@for` 局部可用。
16. **循环变量**：子帧绑定，静默遮蔽外层；循环外恢复；不进帧级声明表。
17. **include 读取缓存**：同一加载过程中同一路径只读一次磁盘。
```

- [ ] **Step 5: 核对**

Run: `npm test`（确认无测试受影响）+ 打开 `docs/LANGUAGE.md` 人工核对 §2.2 `@for` 小节渲染无误（嵌套代码块缩进正确）。
Expected: 全量 PASS；文档结构完整。

---

## Self-Review 记录

**1. 规格覆盖检查**：
- §2 三种形式语法 → Task 2（解析）+ Task 3（渲染）✓
- §3.1-3.7 块结构/@else/范围边界/遮蔽/空缺/@set 限制/32768 上限 → Task 2/3 ✓
- §3.8 六条边界情况：循环内 include（Task 2 collectIncludes + Task 3 测试）、collectMissing 穿透（Task 4）、@else 附着嵌套（Task 2 测试）、嵌套上限（Task 3）、`in` 切分（Task 2 splitIn + 测试）、`?? {}` idiom（Task 3 测试）✓
- include 读取缓存（规格 §3.8 第二条 + §4.3）→ Task 5 ✓
- §4.1-4.7 实现架构 → Task 2/3/4/5 ✓（ForIterable 类型、子帧方案、错误码齐全）
- §5 文档 → Task 7 ✓
- §6 测试表 → Task 1/2/3/4/5/6 的测试步骤 ✓
- §7 YAGNI：不引入数组（Task 3 E_TYPE 测试）、范围边界仅字面量（Task 2 E_FOR_RANGE 测试）、无步长/递减（解析层即拒绝非 `\d+` 边界）✓

**2. 占位符扫描**：无 TBD/TODO；每个 Step 含完整代码或精确命令。

**3. 类型一致性检查**：
- `ForIterable`：Task 2 定义，Task 3 `resolveIterable(n.iterable.kind === "range" …)`、Task 4 `n.iterable.kind === "expr"` 使用一致 ✓
- for 节点字段：`vars` / `iterable` / `body` / `elseLines`——Task 2 定义与 Task 3/4 使用一致（body 而非 ifLines）✓
- `MAX_FOR_ITERATIONS`：Task 3 定义导出，Task 3 测试与文档引用一致 ✓
- `resolveIncludes` 第 4 参 `cache`：Task 5 定义，递归透传一致 ✓
- 错误码字符串：`E_FOR_FORMAT` / `E_FOR_EXPECT_BRACE` / `E_FOR_RANGE` / `E_FOR_LIMIT` 在实现与测试中拼写一致 ✓
