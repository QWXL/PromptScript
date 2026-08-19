# PromptScript for VS Code

为 [PromptScript](https://moon.chumenta.cn)（舒月项目 / MoonChatAI 平台）提示词脚本语言提供 VS Code 编辑器支持。PromptScript 是一种面向复杂 AI 提示词编排的轻量级模板语言，源仓库为 `platform/promptscript`（npm 包，含 CLI 与渲染器）。

## 功能

- **语法高亮**
  - 指令行：`@set name = expr`、`@if(expr) {`、`@else {`、`@else @if(expr) {`（else-if 链，可与 `}` 同行连接）、`@for v in rec {`、`@include("path")`
  - 插值槽位：`{expr}`（含 `??` 空值回退、三元表达式、`true/false/null`、数字）
  - 字符串：双引号 / 单引号（含转义）
  - 注释：`//` 行注释、`/* … */` 块注释（与解析器语义一致：仅行首整行、指令行/代码模式行尾部识别，引号感知，文章行中间 `http://` 等原样；行首 `\//` 可转义。详见语言包 `docs/LANGUAGE.md` §2.5）
  - 语法文件在 `../syntaxes/` 中是单一事实来源，`npm run sync-grammar` 自动同步；`npm run test:grammar` 用 vscode-textmate 跑 spec 边界用例回归
  - 非法指令：`@foo`（未识别的 `@` 指令）标记为错误
- **注释切换**：`Ctrl+/`（行）与 `Shift+Alt+A`（块）
- **括号配对 / 自动闭合**：`{ }`、`[ ]`、`( )` 与引号
- **缩进规则**：`{` 结尾的行自动缩进，`}` 自动回退
- **文件关联**：`.promptscript` 与 `.ps`

## 示例

```promptscript
@set user.name = "阿月"
@set user.loggedIn = true
@if(user.loggedIn) {
你好，{user.nickname ?? user.name}！今天是{date.today}。
} @else @if(user.registered) {
请先注册。
} @else {
请先登录。
}
@for k, v in tags {
- {k}：{v}
}
// 内联其他文件
@include("shared/footer.ps")
```

## 安装

### 方式一：源码开发调试（F5）

1. 用 VS Code 打开本目录（`platform/promptscript/vscode`）
2. 安装依赖：`npm install`
3. 按 `F5` 启动“扩展开发宿主”，新建 `.ps` 文件即可看到高亮

### 方式二：从 vsix 安装

1. 打包（见下节）得到 `.vsix` 文件
2. VS Code 扩展面板 → `⋯` → **从 VSIX 安装…** 选择该文件

## 打包分发（生成 .vsix）

```bash
# 方式一：一条命令（无需安装任何依赖，自动下载 @vscode/vsce）
npx @vscode/vsce package

# 方式二：使用项目脚本（推荐，先同步语法文件再打包）
npm install
npm run package
```

两种方式都会先在 `vscode:prepublish` 阶段运行 `sync-grammar`，把规范语法同步到本扩展，产物为：

```
vscode-promptscript-0.0.1.vsix
```

### 发布到 VS Code Marketplace（可选）

1. 在 [Azure DevOps](https://dev.azure.com) 注册发布者（publisher，`package.json` 中当前为 `moonchatai`，发布前请改为自己的）
2. 获取 Personal Access Token（`Marketplace → Manage` 权限）
3. 执行：

```bash
npx @vscode/vsce login moonchatai   # 换成你的 publisher
npx @vscode/vsce publish
```

## 目录结构

```
promptscript/vscode/
├── package.json                  # 扩展清单（contributes.languages / grammars）
├── language-configuration.json   # 注释、括号、自动闭合、缩进
├── syntaxes/
│   └── promptscript.tmLanguage.json   # 语法副本（由 sync-grammar 生成）
├── scripts/
│   └── sync-grammar.js           # 从 ../syntaxes/ 同步规范语法
├── icon/icon.png                 # 扩展图标
├── README.md / CHANGELOG.md / LICENSE
└── .vscode/launch.json           # F5 扩展开发调试配置
```

## License

Apache-2.0，与 PromptScript 语言包一致。
