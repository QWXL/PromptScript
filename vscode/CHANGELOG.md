# Changelog

## 0.0.1 (2026-08-19)

- 首个版本
- 语法高亮：`@set` / `@if` / `@else` / `@include` 指令、`{expr}` 插值（`??`、三元、布尔/数字）、单双引号字符串与转义、`//` 与 `/* */` 注释、非法指令标记
- 语言配置：注释切换（`Ctrl+/`）、括号配对与自动闭合、`{` 块缩进
- 文件关联：`.promptscript`、`.ps`
- 构建：`scripts/sync-grammar.js` 从 `../syntaxes/` 同步规范语法；`@vscode/vsce` 打包为 vsix
