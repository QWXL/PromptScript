# 同行连接：`} @else` 与 `@else @if` 链（2026-08-19）

> 状态：已获用户批准（2026-08-19）。为 PromptScript 的块系统增加同行连接语法：`} @else {` 与 else-if 链 `} @else @if(expr) {`。

## 1. 背景与目标

当前 `}` 必须独占一行闭合、`@else {` 必须独占一行。宿主模板中紧密的 if/else 结构被拆成多行，可读性差；`else if` 场景只能手写嵌套（`@else { @if(expr) { … } }`），缩进层级深。

**目标**：允许 `}` 与紧随的 `@else` 同行连接；允许 `@else` 与 `@if` 同行组成 else-if 链。**纯语法糖**——AST 与手写形式逐字节一致，不引入任何新语义。

## 2. 语法

| 行 | 等价手写 | 说明 |
|---|---|---|
| `} @else {` | `}` + `@else {` | 闭合 + 附着（空白容忍，`}@else{` 亦可） |
| `} @else @if(expr) {` | `}` + `@else {` + `@if(expr) {` | 闭合 + 附着 + 开新 if 块（else-if 链） |
| `@else @if(expr) {`（独立行） | `@else {` + `@if(expr) {` | else-if 链，不含同行闭合 |
| `@else {` / `@if(expr) {` | — | 既有形式不变 |

示例：

```promptscript
@if(a) {
  "甲"
} @else @if(b) {
  "乙"
} @else {
  "丙"
}
```

## 3. 语义

1. **纯语法糖**：`} @else @if(expr) { … }` 产出的 AST 与 `@else { @if(expr) { … } }` **逐字节一致**（else 分支内含一个 block 节点）。
2. **解析原理**（复用现有 attachTo 机制 + 一处小扩展）：`@else @if(expr) {` 处理 = 解析 `@if` 条件 → **预创建** block 节点直接写入前一块的 `elseLines`（即附着）→ 压入带 `fillIfLines` 标记的 attachTo 条目，闭合时把 `ifLines`/`elseLines` 回填到预置节点。链的闭合次数与手写嵌套**一致**（`} @else @if(b) { … } @else { … }` 以与 `@else { @if(b) { … } @else { … } }` 相同的 `}` 数收尾），**不需要**额外收尾 `}`。
3. **链可任意长**：`} @else @if(c) {` 后可继续 `} @else @if(d) {`、`} @else {`，栈机制天然支持。
4. **适用范围**：`@if` 与 `@for` 块后均可（`@else` 附着规则通用，深度检查沿用）。嵌套场景（块内块）同样成立。
5. **错误处理**（既有错误码，触发路径不变）：
   - `} @else` / `@else` 载荷非 `{` 且非 `@if` → `E_ELSE_EXPECT_BRACE`（消息补充 else-if 形式）
   - `} @else {` / `} @else @if(…) {` 前无未闭合块 → `E_BLOCK_STRAY`（`}` 部分）
   - `@else @if` 前无完整块 / 已有 else → `E_ELSE_ORPHAN`
   - `@else @if(expr)` 缺 `{` / 载荷非法 → `E_IF_EXPECT_BRACE`（复用 case "if" 校验）
   - `@elsex`（非 `@else` 边界）→ 既有 `E_SYNTAX`（`}` 行消息补充说明支持形态）
6. **不做**：`} /* 注释 */ @else {` 行内注释连接（YAGNI）；`@elseif` 独立指令（用链式即可）；`} @if` 无 else 的同行（无意义）。

## 4. 实现架构

### 4.1 词法（src/lexer.ts）

`}` 行判定扩展为三态（`ScannedLine` 联合类型加 `closeElse`，带 `payload`）：

```ts
  if (t.startsWith("}")) {
    // 同行连接：} @else …（payload 为 @else 之后的部分：`{` 或 `@if(…) {`）
    const m = /^}\s*@else\b(.*)$/.exec(t);
    if (m) return { kind: "closeElse", line, text, payload: m[1]!.trim() };
    if (t !== "}") {
      throw psError("parse", "", line, "E_SYNTAX",
        "`}` 必须独占一行闭合块，或同行连接 `@else {` / `@else @if(expr) {`");
    }
    return { kind: "close", line, text };
  }
```

`@else @if(expr) {` 独立行无需词法改动（directive/else，payload 即 `@if(expr) {`）。

### 4.2 解析器（src/parser.ts DocParser）

抽取共享方法（case "close" / "else" / "if" 与新增 case "closeElse" 复用）：

- `closeBlock(line)`：现有 case "close" 主体（pop、depth--、attachTo 回写 / 构造节点、登记 lastClosed、currentLines().push）。attachTo 回写扩展：`fillIfLines` 标记时把条目 `ifLines` 回填到预置节点（else-if 链）。
- `attachElse(payload, line): string | null`：payload 为 `{` → null；匹配 `/^@if\b\s*(.+)$/` → 返回 `@if` 后载荷（如 `(b) {`）；否则 `E_ELSE_EXPECT_BRACE`（消息含 else-if 形式）。
- `parseIfCond(payload, line): Expr`：`{` 结尾校验 `E_IF_EXPECT_BRACE`、剥括号解析 `parseExpr`（case "if" 与 else-if 共用）。
- `pushIf(payload, line)`：`parseIfCond` + 压栈 + depth++（case "if" 用）。
- `handleElse(payload, line)`：attachElse 校验 → E_ELSE_ORPHAN 检查 → 若为 else-if（attachElse 返回非 null）：`parseIfCond` 解析条件 → **预创建** block 节点写入 `lastClosed.block.elseLines` → 压 `{ attachTo: 预置节点, fillIfLines: true, ifLines: [], elseLines: null }` 条目 → depth++；否则走普通 else：压 attachTo 条目（`ifLines: b.ifLines ?? []`、`elseLines: []`）→ depth++。

case 接线：`"close"` → `closeBlock`；`"closeElse"` → `closeBlock` + `handleElse(payload)`；`"else"` → `handleElse(scanned.payload ?? "")`；`"if"` → `pushIf(scanned.payload ?? "")`。

### 4.3 求值器（src/evaluator.ts）

**零改动**——else-if 链产出的 AST 与手写嵌套一致，既有渲染路径天然覆盖。仅补渲染测试。

### 4.4 语法高亮（syntaxes/promptscript.tmLanguage.json）

**零改动**——`@`/`}` 行 begin 块内的 `@(set|if|else|include|for)\b` 中间行 pattern 已覆盖同行 `@else @if`；`} @else {` 的 `@else` 由同 pattern 命中。grammar 测试回归验证。

### 4.5 文档（docs/LANGUAGE.md）

- §2.1 行类型表：闭合行行描述更新（"恰为 `}`，或 `} @else {` / `} @else @if(expr) {` 同行连接"）。
- §2.2 `@if` 小节：`@else` 附着规则补充同行连接与 else-if 链说明（含等价手写示例）。
- §2.2 `@for` 小节：`@else` 附着规则引用同款同行连接能力（一句话）。
- §5 边界条目 2/13：`}` 闭合规则更新为"独占一行，或与紧随的 `@else` 同行连接"。

### 4.6 错误消息

- `E_SYNTAX`（`}` 行）："`}` 必须独占一行闭合块，或同行连接 `@else {` / `@else @if(expr) {`"
- `E_ELSE_EXPECT_BRACE`："@else 必须紧跟 `{`（@else {），或以 `@if(…) {` 开头（else-if 链）"

## 5. 测试

| 文件 | 用例 |
|---|---|
| test/lexer.test.ts | `} @else {` / `}@else{` → closeElse；`} @else @if(b) {` → closeElse payload=`@if(b) {`；`} @else` → closeElse payload=""；`} x` / `} @elsex` → E_SYNTAX；`@else @if(b) {` 独立行 → directive/else |
| test/parser.test.ts | `} @else {` 与两行等价（单节点 elseLines）；else-if 链（else 分支含 block 节点 + 链尾 else 附着）；`@else @if` 独立行；@for 后同行 else + 链；错误：`} @else` → E_ELSE_EXPECT_BRACE、无块 `} @else {` → E_BLOCK_STRAY、双 else → E_ELSE_ORPHAN、链未闭合 → E_BLOCK_UNCLOSED |
| test/evaluator.test.ts | 三链渲染（a 真→甲 / b 真→乙 / 否则→丙）；@for 空迭代走 else-if 链（flag 真→有标记 / 假→无标记 / 非空→迭代内容） |
| test/grammar.test.ts | 无改动，回归验证 |

## 6. 不做（YAGNI）

- 不引入 `@elseif` 指令（链式语法糖已覆盖）。
- 不支持 `} /* 注释 */ @else {` 行内注释。
- 不支持 `} @else {` 之外的其他 `}` 同行内容（如 `} @if` 无 else——无意义，报 E_SYNTAX）。
- 求值器、CLI、类型系统零改动。
