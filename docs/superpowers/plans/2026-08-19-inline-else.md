# 同行连接：`} @else` 与 `@else @if` 链 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许 `}` 与 `@else` 同行连接（`} @else {`），并支持 else-if 链（`} @else @if(expr) {`、`@else @if(expr) {`）——纯语法糖，AST 与手写嵌套逐字节一致。

**Architecture:** 词法器 `}` 行判定扩展出 `closeElse` 行型（payload 为 `@else` 之后的内容）；解析器把 case "close"/"else"/"if" 主体抽成共享方法（closeBlock / attachElse / parseIfCond / pushIf / handleElse），`closeElse` = 先 close 再 handleElse；else-if 链采用**预置节点 + fillIfLines 回填**（`@else @if(expr) {` 预创建 block 节点直接写入前块 elseLines，链以与手写嵌套相同的 `}` 数收尾）。求值器、语法高亮零改动。

**Tech Stack:** TypeScript（Node ≥ 22）、Vitest。无新依赖。

## Global Constraints

- 规格文档：`docs/superpowers/specs/2026-08-19-inline-else-design.md`（本计划的唯一行为契约）。
- **无 git 仓库**（promptscript 目录及上层均不是 git 仓库）——所有 commit 步骤改为运行测试确认，不执行 git 命令。
- 测试命令：`npx vitest run test/<file>.test.ts`（单文件）或 `npm test`（全量）。
- 错误码全部复用既有（无新码）：`E_ELSE_EXPECT_BRACE`、`E_BLOCK_STRAY`、`E_ELSE_ORPHAN`、`E_IF_EXPECT_BRACE`、`E_SYNTAX`。
- 求值器 `src/evaluator.ts` 与语法高亮 `syntaxes/promptscript.tmLanguage.json` **零改动**（Task 3 只加测试；Task 4 只改文档）。
- 消息文本（精确）：
  - `E_SYNTAX`（`}` 行）：`` `}` 必须独占一行闭合块，或同行连接 `@else {` / `@else @if(expr) {` ``
  - `E_ELSE_EXPECT_BRACE`：`` @else 必须紧跟 `{`（@else {），或以 `@if(…) {` 开头（else-if 链） ``

---

### Task 1: 词法 `closeElse` 行型

**Files:**
- Modify: `src/lexer.ts:6`（LineKind）、`src/lexer.ts:31-36`（`}` 分支）
- Test: `test/lexer.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `scanLine` 对 `}` 行返回 `{ kind: "closeElse", line, text, payload }`（payload = `@else` 之后 trim 过的内容：`{`、`@if(…) {` 或空串）——Task 2 解析器依赖。

- [ ] **Step 1: 写失败测试**

在 `test/lexer.test.ts` 的 "close：trimStart 后恰为 }" 测试之后追加：

```ts
  test("closeElse：} @else 同行连接（空白容忍，payload 为 @else 之后内容）", () => {
    expect(scanLine("} @else {", 1, "code")).toEqual({ kind: "closeElse", line: 1, text: "} @else {", payload: "{" });
    expect(scanLine("}@else{", 2, "code").kind).toBe("closeElse");
    expect(scanLine("} @else @if(b) {", 3, "code")).toEqual({ kind: "closeElse", line: 3, text: "} @else @if(b) {", payload: "@if(b) {" });
    expect(scanLine("} @else", 4, "code")).toEqual({ kind: "closeElse", line: 4, text: "} @else", payload: "" });
    expect(scanLine("  } @else {", 5, "code").kind).toBe("closeElse");
  });

  test("close 行错误：} 后非 @else 连接仍报错", () => {
    err(() => scanLine("} x", 1, "code"), "E_SYNTAX");
    err(() => scanLine("} @elsex", 2, "code"), "E_SYNTAX");
  });
```

（`err` helper 在文件顶部已有。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/lexer.test.ts`
Expected: 新测试 FAIL（`} @else {` 当前抛 E_SYNTAX）。

- [ ] **Step 3: 实现**

`src/lexer.ts:6`：

```ts
export type LineKind = "blank" | "directive" | "raw" | "literal" | "close" | "closeElse";
```

`src/lexer.ts:31-36`（`}` 分支）替换为：

```ts
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
```

（`ScannedLine` 接口的 `payload?: string` 已可选，无需类型改动。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/lexer.test.ts`
Expected: PASS。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 1 完成）。

---

### Task 2: 解析器共享方法 + `closeElse` 接线

**Files:**
- Modify: `src/parser.ts`（DocParser：抽取 closeBlock/attachElse/pushIf/handleElse，case "close"/"else"/"if" 改调共享方法，新增 case "closeElse"）
- Test: `test/parser.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `{ kind: "closeElse"; payload }`。
- Produces: `} @else {` / `} @else @if(…) {` / `@else @if(…) {` 解析为与手写嵌套逐字节一致的 AST——Task 3 渲染测试依赖。

- [ ] **Step 1: 写失败测试**

在 `test/parser.test.ts` 末尾追加（`err` / `files` helper 已有）：

```ts
describe("同行连接：} @else 与 else-if 链", () => {
  test("} @else { 与两行等价：单节点 + elseLines", () => {
    const d = parseDocument('@if(a) {\n  "x"\n} @else {\n  "y"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; ifLines: unknown[]; elseLines: unknown[] };
    expect(b.type).toBe("block");
    expect(b.ifLines.length).toBe(1);
    expect(b.elseLines.length).toBe(1);
    expect(d.lines.length).toBe(1);
  });

  test("else-if 链：else 分支含 block 节点（与手写嵌套 AST 一致）", () => {
    const d = parseDocument('@if(a) {\n  "甲"\n} @else @if(b) {\n  "乙"\n} @else {\n  "丙"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; elseLines: { type: string; cond: unknown; elseLines: unknown[] }[] };
    expect(b.elseLines).toHaveLength(1);
    const e = b.elseLines[0]!;
    expect(e.type).toBe("block");
    expect(e.cond).toEqual({ kind: "path", name: "b" });
    expect(e.elseLines).toHaveLength(1);   // 链尾 @else 附着在 b 块上
  });

  test("@else @if 独立行（无同行 }）", () => {
    const d = parseDocument('@if(a) {\n  "x"\n}\n@else @if(b) {\n  "y"\n}\n', "a.ps");
    const b = d.lines[0] as { type: "block"; elseLines: { type: string }[] };
    expect(b.elseLines[0]!.type).toBe("block");
  });

  test("@for 后同行 else + else-if 链", () => {
    const d = parseDocument('@for v in tags {\n  "{v}"\n} @else @if(flag) {\n  "空"\n} @else {\n  "无"\n}\n', "a.ps");
    const f = d.lines[0] as { type: "for"; elseLines: { type: string }[] };
    expect(f.type).toBe("for");
    expect(f.elseLines[0]!.type).toBe("block");
  });

  test("错误路径", () => {
    err(() => parseDocument('@if(a) {\n  "x"\n} @else\n', "a.ps"), "E_ELSE_EXPECT_BRACE");          // 缺 {
    err(() => parseDocument("} @else {\n", "a.ps"), "E_BLOCK_STRAY");                                // 无块
    err(() => parseDocument('@if(a) {\n  "x"\n} @else {\n  "y"\n}\n} @else {\n  "z"\n}\n', "a.ps"), "E_ELSE_ORPHAN"); // 双 else
    err(() => parseDocument('@if(a) {\n  "x"\n} @else @if(b) {', "a.ps"), "E_BLOCK_UNCLOSED");       // 链未闭合
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/parser.test.ts`
Expected: 新测试 FAIL（switch 无 `closeElse` case——TS 编译错或静默跳过；`} @else {` 抛 E_SYNTAX）。

- [ ] **Step 3: 实现**

`src/parser.ts` DocParser 四处修改：

**(a) case "close"（约第 79-96 行）替换为调用共享方法**：

```ts
        case "close":
          this.closeBlock(i + 1);
          break;
```

**(b) case "if"（约第 109-117 行）替换为调用共享方法**：

```ts
            case "if":
              this.pushIf(scanned.payload ?? "", i + 1);
              break;
```

**(c) case "else"（约第 118-137 行）替换为调用共享方法**：

```ts
            case "else":
              this.handleElse(scanned.payload ?? "", i + 1);
              break;
```

**(d) case "directive" 的 switch 之后（`case "include"` 之后）新增 `case "closeElse"`（与 `case "close"` 同级，在 scanned.kind 的 switch 内）**：

```ts
        case "closeElse":
          this.closeBlock(i + 1);
          this.handleElse(scanned.payload ?? "", i + 1);
          break;
```

**(e) BlockEntry 类型加 `fillIfLines?: boolean`（约第 46-50 行）**：

```ts
interface BlockEntry {
  file: string; line: number;
  cond?: Expr; iterable?: ForIterable; vars?: string[];
  ifLines: Node[]; elseLines: Node[] | null; attachTo?: Node;
  fillIfLines?: boolean;   // else-if 链：闭合时把 ifLines 回填到预置节点
}
```

**(f) 类内新增五个私有方法（放在 `currentLines()` 之前）**——注意：else-if 链采用**预置节点 + fillIfLines 回填**设计（规格 §3.2/§4.2）：`@else @if(expr) {` 预创建 block 节点直接写入前块 `elseLines`，链以与手写嵌套相同的 `}` 数收尾，**无需额外闭合**：

```ts
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
      this.lastClosed = { block: node, depth: this.depth };
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
```

注意：既有 `case "else"` 中 `ifLines: b.ifLines` 已改为 `?? []`（Task 2 既改），handleElse 保持该形式。测试输入均为**自然闭合形态**（链以与手写嵌套相同的 `}` 数收尾，不要给链测试补额外 `}`——补了会 E_BLOCK_STRAY）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/parser.test.ts`
Expected: PASS（含既有块配对、@else 附着、@for 全部回归）。

- [ ] **Step 5: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 2 完成）。

---

### Task 3: 渲染语义测试（求值器零改动）

**Files:**
- Test: `test/evaluator.test.ts`（只加测试，不改 src）

**Interfaces:**
- Consumes: Task 2 的 AST。
- Produces: 渲染行为钉住测试（else-if 链、@for 空迭代 else-if）。

- [ ] **Step 1: 写失败测试**

在 `test/evaluator.test.ts` 的 "@for 循环" describe 之后追加（`R` / `err` helper 已有）：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/evaluator.test.ts`
Expected: 新测试 FAIL（Task 2 未完成前 `} @else {` 行报 E_SYNTAX）。

- [ ] **Step 3: 验证实现（无 src 改动）**

Run: `npx vitest run test/evaluator.test.ts`
Expected: PASS——求值器对 else-if 链零改动即正确（AST 与手写嵌套一致，既有渲染路径覆盖）。若失败说明 Task 2 的 AST 形状有误，报告而不是绕过。

- [ ] **Step 4: 回归确认（无 git，替代 commit）**

Run: `npm test`
Expected: 全量 PASS（Task 3 完成）。

---

### Task 4: 文档（docs/LANGUAGE.md）

**Files:**
- Modify: `docs/LANGUAGE.md`
- Test: 无新测试（`npm test` 回归确认文档改动无测试影响）

**Interfaces:**
- Consumes: 以上全部任务的最终行为。
- Produces: 语言规范与实现一致。

- [ ] **Step 1: 更新 §2.1 行类型表**

找到闭合行/指令行相关行（`}` 独占一行描述），更新为支持同行连接。参考措辞（以文件实际内容为准做同义修改）：

```markdown
| 闭合行 | 恰为 `}`，或 `} @else {` / `} @else @if(expr) {` 同行连接 | 闭合当前花括号块（同行连接时同时附着 `@else` 或开 else-if 链） |
```

- [ ] **Step 2: 更新 §2.2 `@if` 小节**

`@else` 附着规则处（"`@else {` 附着在紧邻的前一个完整 `@if` 块之后，单独占一行"）更新为：

```markdown
- **`@else`**：附着在紧邻的前一个完整 `@if` 块之后；可与闭合 `}` 同行连接（`} @else {`）。也可紧跟 `@if` 组成 **else-if 链**：`} @else @if(expr) {`（或独立行 `@else @if(expr) {`），等价于手写 `@else { @if(expr) { … } }` 的语法糖，可链式任意长度。
```

`}` 闭合规则处（"`}` 独占一行闭合"）更新为：

```markdown
- **闭合**：`}` 独占一行闭合，或与紧随的 `@else` 同行连接（`} @else {` / `} @else @if(expr) {`）。
```

- [ ] **Step 3: 更新 §2.2 `@for` 小节与 §5 边界条目**

`@for` 小节的 "`@else` 附着规则与 `@if` 相同" 处追加一句：

```markdown
`@else` 同样支持同行连接与 else-if 链（`} @else {` / `} @else @if(expr) {`）。
```

§5 边界条目 2（`@if` 花括号块）与 13（`@for` 块）的 `}` 闭合描述处，更新为与 §2.2 一致的同义措辞（"独占一行，或与紧随的 `@else` 同行连接"）。

- [ ] **Step 4: 核对**

Run: `npm test`
Expected: 全量 PASS；打开 `docs/LANGUAGE.md` 人工核对 §2.1/§2.2/§5 三处措辞一致、无矛盾。

---

## Self-Review 记录

**1. 规格覆盖检查**：
- §2 四种行形态 → Task 1（lexer）+ Task 2（parser）✓
- §3.1 纯语法糖 / §3.2 attachTo 承接原理 / §3.3 任意长度链 / §3.4 适用范围 → Task 2 实现 + Task 3 渲染测试 ✓
- §3.5 五种错误路径 → Task 1/2 测试 ✓（E_ELSE_EXPECT_BRACE、E_BLOCK_STRAY、E_ELSE_ORPHAN、E_IF_EXPECT_BRACE、E_SYNTAX）
- §4.1 词法三态 + §4.2 共享方法 → Task 1/2 ✓
- §4.3 求值器零改动 / §4.4 高亮零改动 → Task 3 测试验证 / grammar 测试回归 ✓
- §4.5 文档 → Task 4 ✓
- §5 测试矩阵 → Task 1/2/3 ✓
- §6 YAGNI（无 @elseif、无行内注释、无其他 } 同行内容）→ Task 1 的 `} x` E_SYNTAX 测试 ✓

**2. 占位符扫描**：无 TBD/TODO；每个 Step 含完整代码或精确命令。

**3. 类型一致性检查**：
- `closeElse` 行型 + payload：Task 1 定义（LineKind 加 "closeElse"），Task 2 `scanned.payload` 消费一致 ✓
- `closeBlock(line)` / `attachElse(payload, line): string | null` / `pushIf(payload, line)` / `handleElse(payload, line)`：Task 2 定义与接线一致（case "close"/"else"/"if" 调用签名、closeElse 先 close 再 handleElse）✓
- `handleElse` 中 `ifLines: b.ifLines ?? []` 与既有 Task 2（@for）改动保持一致 ✓
- 错误消息文本与 Global Constraints 一致 ✓
