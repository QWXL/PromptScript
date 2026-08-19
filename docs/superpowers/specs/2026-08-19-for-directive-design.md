# @for 指令设计（2026-08-19）

> 状态：已获用户批准（2026-08-19）。为 PromptScript 语言新增 `@for` 循环指令，支持记录条目迭代与整数范围迭代。

## 1. 背景与目标

PromptScript 目前只有 `@set` / `@if` / `@else` / `@include` 四个指令，缺少循环能力。宿主注入的记录数据（如标签映射、配置项）无法逐条渲染，也无法按次数重复渲染段落。

**目标**：增加 `@for` 指令，支持两种迭代源——记录条目与数字范围。类型系统**不变**（不引入数组）。

## 2. 语法

```promptscript
@for 变量 in 数据源 {
  …
}
@else {          // 可选：空迭代时渲染
  …
}
```

| 形式 | 变量 | 数据源 | 语义 |
|---|---|---|---|
| `@for v in 记录表达式 {` | 单变量 = **值** | 记录（@set 声明或宿主注入） | 按记录键序遍历，`v` 绑定每条值 |
| `@for k, v in 记录表达式 {` | 双变量 = **键 + 值** | 同上 | `k` 绑定键，`v` 绑定值 |
| `@for i in 1..5 {` | 单变量 = **计数器** | 整数范围 | 闭区间 `[1,5]`，共 5 次 |

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
```

## 3. 语义

1. **块结构**：`@for` 行必须以 `{` 结尾、`}` 独占一行闭合（与 `@if` 一致）；块内采用代码模式；支持嵌套 `@for`（内层遮蔽外层循环变量）。`@for` 可在顶层或 `@if` 块内出现（与 `@include` 一致，栈机制天然支持）。
2. **`@else`**：空记录或 `start > end` 的空范围 → 渲染 `@else` 分支（若有）。附着规则与 `@if` 的 `@else` 相同（紧邻前一个完整块）。
3. **范围边界**：非负整数（语言不支持负数），闭区间；`start > end` 是空迭代而非错误；非整数边界（小数、负数、路径表达式）→ 解析错误 `E_FOR_RANGE`。范围是 `@for` 局部语法，不是通用表达式（`@set x = 1..5` 仍报错）。
4. **静默遮蔽**：循环体是隐式子帧，循环变量临时遮蔽外层同名绑定（宿主注入、`@set`、外层循环变量），循环外恢复。与 include 子帧遮蔽语义一致。循环变量**不进帧级声明表**——无 `@set` 式重名检查、无 TDZ。
5. **空缺语义**：数据源引用未绑定名 → 渲染期 `E_UNBOUND`（与 `@if` 谓词一致）；记录值在循环体内沿用现有规则（`null` → 空串、嵌套记录可点访问、直接渲染记录值 → `E_RECORD_RENDER`）。
6. **`@set` 限制不变**：循环体内声明 `@set` 仍是语法错误（`E_SET_IN_BLOCK`，由现有 `depth > 0` 检查覆盖）。
7. **安全上限**：单次 `@for` 迭代超过 32768 次（2^15）→ 渲染期 `E_FOR_LIMIT` 错误。记录迭代先算出总条目数再循环。上限取 2^15 而非 2^31-1：上限的意义是快速失败——若设 2^31-1，笔误的 `0..1000000000` 会渲染数小时才撞线；32768 对任何现实模板（3 万行输出远超 LLM 上下文）足够，失控循环几秒内即被拦下。

**记录键序**：`Object.keys` 顺序（数字键升序在前、字符串键按插入序），与记录字面量 / JSON 注入一致。

### 3.8 边界情况（循环 × include / 嵌套）

- **循环内 `@include`**：`@include` 允许出现在 `@for` 循环体内（与 `@if` 块内一致）。加载期 `collectIncludes` 递归遍历 for 节点的 body/elseLines，循环内 include 与块内 include 同一路径解析。渲染期被包含文件的子帧以**当前迭代的子帧**为父帧——被包含文件可以直接引用循环变量（子帧可访问父帧绑定，见 3.2）；被包含文件内的 `@set` 与循环变量同名时静默遮蔽循环变量（子帧优先）。空迭代时循环体不渲染，include 不执行。文件缺失 / 循环引用错误与其它位置一致（`E_INCLUDE_MISSING` / `E_INCLUDE_CYCLE`）。
- **include 读取缓存**：同一 include 节点渲染期复用已解析的 `node.doc`，循环迭代**不重读磁盘**（现有行为，渲染期帧每次新建、doc 只读）。同一路径被**多个** include 节点引用时（如顶层 + 循环体各一个），加载期按解析后路径缓存文件文本——**一次 resolve 调用内同一路径只读一次磁盘**。缓存存**文本**而非解析后的 Document：每个 include 节点的子文档 `parent` 指针按节点而异（父子帧链），Document 不可跨节点共享；文本缓存 + 每节点一次解析（内存解析成本远低于磁盘 IO）。`loadFile` 为宿主可注入，约定一次 resolve 内对同一路径的返回确定性（宿主自定义 loader 若按调用返回不同内容，将以首次为准）。
- **`collectMissing` 穿透 include**：循环变量经 include 进入子文档时，boundVars 集合须随 include 节点传入子文档遍历——否则子文档内引用循环变量会被误报为未绑定。
- **`@else` 附着在嵌套下不变**：`@else` 始终附着于同深度最近闭合的块。循环体内先闭合的 `@if` 的 `@else` 附着给内层 `@if`；只有紧跟在 `@for` 闭合 `}` 之后、且深度相同的 `@else` 才附着给 `@for`（既有 `lastClosed.depth` 检查天然保证）。
- **嵌套循环上限**：32768 次上限按**单个** `@for` 计算；嵌套时总渲染量是乘积（如 100×100 = 10000 次总渲染，因每个循环都 < 32768 而不报错），仅当单个循环超过 32768 才报 `E_FOR_LIMIT`。
- **`in` 切分规则**：取第一个深度 0 的 `in`（引号与记录花括号内跳过）。`in` 不是保留字（宽松标识符无保留字概念），`@for in in rec {` 合法（变量名为 `in`）；`@for x in in {` 的数据源是名为 `in` 的路径。
- **空数据源回退 idiom**：`@for k, v in rec ?? {} {` —— 数据源未绑定时 `??` 回退到空记录 → 空迭代 → 走 `@else`，与"无数据时给降级文案"的宿主需求配合。

## 4. 实现架构

### 4.1 AST（src/parser.ts Node 联合类型）

```ts
| { type: "for"; file: string; line: number;
    vars: string[];                                    // 1 或 2 个
    iterable: { kind: "range"; from: number; to: number }
            | { kind: "expr"; expr: Expr };
    body: Node[];
    elseLines: Node[] | null }
```

### 4.2 词法（src/lexer.ts）

`DIRECTIVES` 从 `["set", "if", "else", "include"]` 扩为 `["set", "if", "else", "include", "for"]`。`E_UNKNOWN_DIRECTIVE` 的已知指令提示自动带上 `for`。其余无需改动。

### 4.3 解析器（src/parser.ts DocParser）

- **块栈条目泛化**：现有 `{file, line, cond, ifLines, elseLines, attachTo?}` 增加可选 `iterable?`（`cond` / `iterable` 二选一，`if` 用 cond、`for` 用 iterable）。`}` 闭合（构造 for 节点、记录 lastClosed）与 `@else` 附着（`attachTo` 回写 for 节点的 `elseLines`）机制原样复用。
- **`case "for"` 解析 payload**：
  1. 校验以 `{` 结尾，否则 `E_FOR_EXPECT_BRACE`（对齐 `E_IF_EXPECT_BRACE`）。
  2. **深度感知切分 `in`**：在深度 0、引号外切分关键字 `in`（跳过字符串字面量内与记录花括号内的 `in`，如 `{"in": 1}` 的键名不误切）。找不到 → `E_FOR_FORMAT`。
  3. LHS：逗号分隔的变量名（宽松标识符），1–2 个；0 个或 >2 个、非法名字 → `E_FOR_FORMAT`。范围形式只允许 1 个变量。
  4. RHS 判别：
     - 匹配 `/^\s*(\d+)\s*\.\.\s*(\d+)\s*$/` → `{kind: "range", from, to}`；边界不是非负整数 → `E_FOR_RANGE`。
     - 否则 `parseExpr` → `{kind: "expr", expr}`。
- 循环体内 `@set`：现有 `depth > 0` 检查自动覆盖（`E_SET_IN_BLOCK`），无新逻辑。
- **`collectIncludes` 扩展**（§3.8 循环内 include）：现有函数只递归 `block` 节点的 ifLines/elseLines，需增加对 `for` 节点 body/elseLines 的递归，否则循环内 include 的 `node.doc` 永不解析 → 渲染期 `E_UNRESOLVED`。
- **`resolveIncludes` 读取缓存**（§3.8）：签名扩展 `resolveIncludes(doc, loadFile, stack = [], cache = new Map<string, string>())`——`cache` 为"解析后路径 → 文件文本"，顶层调用新建、递归透传；命中缓存跳过 `loadFile`，未命中先读盘入缓存再解析。循环检测（`stack`）与错误定位（在读盘失败处抛 `E_INCLUDE_MISSING`）不受影响。

### 4.4 求值器（src/evaluator.ts）

**子帧方案**：每次迭代创建 `{parent: frame, doc: frame.doc, bindings: Map}` 子帧，循环变量写入子帧绑定。遮蔽沿 parent 链天然正确、无状态泄漏、嵌套循环天然支持（与 include 的 buildFrame 同构；不用"临时覆盖当前帧 Map"方案——异常时泄漏状态且偏离现有架构）。

```ts
case "for": {
  const items = resolveIterable(n, frame);   // 范围 → 数字列表；表达式 → MISS→E_UNBOUND、非记录→E_TYPE、记录→Object.entries
  const out: string[] = [];
  for (const [k, v] of items) {              // range 时 k 为数字、v 为 k
    const child: Frame = { parent: frame, doc: frame.doc, bindings: new Map() };
    if (n.vars.length === 2) child.bindings.set(n.vars[0]!, k);   // 键
    child.bindings.set(n.vars[n.vars.length - 1]!, v);            // 值 / 计数器
    out.push(...renderLines(n.body, child));
  }
  if (out.length === 0 && n.elseLines) out.push(...renderLines(n.elseLines, frame));
  break;
}
```

- `resolveIterable`：
  - `range`：生成 `[from..to]` 闭区间数字列表；`from > to` → 空数组；**先算长度，超 32768 → `E_FOR_LIMIT`**。
  - `expr`：`evalExpr` → `MISS` → `E_UNBOUND`；非记录（原始值 / `null` / `undefined`）→ `E_TYPE`；记录 → `Object.entries`（键序见 §3）。
- 循环体内引用循环变量 → `lookup` 沿 parent 链先命中子帧绑定，不产生空缺。

### 4.5 collectMissing（src/evaluator.ts）

`walkNode` 增加 `case "for"`：

- 遍历 `iterable.expr`（range 无路径引用，跳过）。
- 遍历 body / elseLines 时维护 `boundVars: Set<string>` 栈：进入 body 压入 `n.vars`，退出弹出；`walkExpr` 的 `path` 分支先查该集合——**循环变量不误报为未绑定**。
- **include 节点穿透**（§3.8）：`include` 节点递归 `walkDoc` 时传入当前 boundVars 集合，子文档内引用循环变量同样不误报。

`walkExpr` 签名需传入 boundVars 上下文（当前递归遍历 decls 的调用传空集合）。

### 4.6 语法高亮（syntaxes/promptscript.tmLanguage.json）

三处加 `for`：

1. comments 段 `(?<=^@)(set|if|else|include)\b` → `(set|if|else|include|for)\b`
2. comments 段 `@(set|if|else|include)\b` → 同上加 `for`
3. directives 段新增 `"match": "\\s*@for\\b"` → `keyword.control.promptscript`

改完后按约定 sync-grammar 再打包 vscode 扩展。

### 4.7 新增错误码

| 码 | 阶段 | 触发 |
|---|---|---|
| `E_FOR_FORMAT` | 解析 | 缺 `in`、变量数 0 或 >2、变量名非法 |
| `E_FOR_EXPECT_BRACE` | 解析 | `@for` 行不以 `{` 结尾 |
| `E_FOR_RANGE` | 解析 | 范围边界不是非负整数（小数、负数、路径表达式） |
| `E_FOR_LIMIT` | 渲染 | 单次迭代 > 32768 次 |

`errors.ts` 无需改动（`psError` 是通用工厂）。

## 5. 文档（docs/LANGUAGE.md）

- §2.1 行类型表：指令行列表加 `@for`。
- §2.2 新增 `@for` 指令小节：语法、三种形式表、语义、示例；`@include` 小节补充"同一 resolve 内同一路径只读一次磁盘"（读取缓存）的行为说明。
- §2.3「暂不支持」：数组仍不支持；补充说明 `..` 范围仅限 `@for` 指令内。
- §3.3 静态规则表：注明循环变量不进帧级声明表（无重名检查、无 TDZ，静默遮蔽）。
- §4.2 求值次序：渲染步增加 @for 子帧求值。
- §4.3 错误分层：渲染期加 `E_FOR_LIMIT`（解析期三码列于解析期）。
- §5 边界：新增条目——`@for` 块结构与 `@if` 一致、空迭代走 `@else`、迭代上限 32768。

## 6. 测试

| 文件 | 用例 |
|---|---|
| test/lexer.test.ts | `@for` 识别为 directive；`@forx` 仍为未知指令 |
| test/parser.test.ts | 三种形式解析；缺 `in` / 变量数错误 / 范围非整数 → 对应错误码；`@for` 未闭合；`@for` + `@else` 附着；嵌套 `@for`；循环体内 `@set` → E_SET_IN_BLOCK；`@for` 不以 `{` 结尾；循环体内 `@include` 被 collectIncludes 收集；`@for` 在 `@if` 块内合法 |
| test/evaluator.test.ts | 记录迭代（单变量=值、双变量=键+值）；空记录 + `@else`；范围闭区间（含 `1..1`）；`start > end` 空迭代 + `@else`；遮蔽恢复（循环外恢复原值）；嵌套循环（内外同名遮蔽）；数据源未绑定 → E_UNBOUND；数据源非记录 → E_TYPE；超 32768 → E_FOR_LIMIT；循环体内直接渲染记录值 → E_RECORD_RENDER；循环变量不进 collectMissing；`rec ?? {}` 空回退 idiom；循环内 `@include` 引用循环变量、被包含文件 `@set` 遮蔽循环变量、空迭代不执行 include；collectMissing 穿透 include 不误报循环变量 |
| test/index.test.ts | 同一路径多个 include 节点（顶层 + 循环体各一个）→ 计数 `loadFile` 只调用一次（读取缓存）；缺失文件仍抛 E_INCLUDE_MISSING；循环内 include 渲染期复用 doc 不重读 |
| test/grammar.test.ts | tmLanguage 含 `for` 关键词（3 处） |

## 7. 不做（YAGNI）

- 不引入数组类型（`PSValue` 不变，`parseToPSValue` 仍拒绝数组）。
- 范围边界不支持表达式（如 `1..n`）；只支持非负整数字面量。
- 不支持步长（step）、不支持递减范围（`start > end` = 空迭代）。
- `..` 不进入通用表达式语法。
- 循环体内不允许 `@set`（维持帧级声明不变）。
- 不新增 `@elseif` 式语法。

## 8. 风险与开放点

- **记录键序**：依赖 JS `Object.keys` 顺序，写入文档作为契约（数字键升序在前、字符串键插入序）。
- **32768 上限**：先取常数（`MAX_FOR_ITERATIONS`），若宿主确有超过 3 万条的超大记录需求可在后续版本参数化。
- **`in` 切分**：深度感知切分需与 `splitFallback`（expr.ts 的 `|` 切分）同样严谨——跳过引号与嵌套括号/花括号，防 `@for x in {"in": 1}` 误切。实现时复用同一扫描模式。
