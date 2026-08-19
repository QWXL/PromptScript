# PromptScript

中文版本（当前）| [English Version](./README_EN.md)

PromptScript 是一种面向复杂 AI 提示词编排的轻量级模板语言，提供：

- 条件：通过 `@if` 与 `@else` 进行各种判断（支持 `@else @if(expr)` else-if 链）
- 循环：通过 `@for` 遍历记录条目（`@for k, v in rec`）或整数范围（`@for i in 1..5`），可接 `@else` 以处理空记录情况
- 跨文件引用：通过 `@include` 内联其他文件，更模块化
- 动态字段：通过 `{path}` 插值，具有空值回退与三元表达式等语法
- 变量：通过 `@set` 声明，可用于减少重复和提高可读性
- 记录：一种字面量类型 `{key: value}`
- 纯函数渲染器：`static render()`
- 注释：就是注释而已

等功能，在**轻量**、**简洁**、**静态**的基础上，方便开发者组织复杂的 AI 提示词。

> PromptScript 是[舒月项目](https://moon.chumenta.cn)的一部分。

> PromptScript 使用了 Deepseek AI 辅助实现。

## 快速上手

```bash
$ npm i promptscript
```

```typescript
import { PromptScript } from "promptscript";

const ps = new PromptScript(`
@set tone = user.level > 50 ? "亲切" : "客气"
// 这是一些注释，将在解析时被剔除
用户为{user.nickname ?? "朋友"}，回复语气应{tone}。
@if (showWeather) {
  "天气：{env.weather | 未知}"
} @else {
  "不允许提供天气信息"
}
@for k, v in tags {
  "- {k}：{v}"
} @else {
  "用户暂无标签"
}
`);

const missing = ps.collectMissing(); // missing = ["user.level", "user.nickname", "showWeather", "env.weather", "tags"]
// …… 宿主应自己提供缺失字段
const text = ps.render({
  "user.level": 60,
  "user.nickname": "舒月",
  showWeather: true,
  "env.weather": undefined,
  tags: { 性格: "温柔", 爱好: "写作" },
});
// text = "用户为舒月，回复语气应亲切。\n天气：未知\n- 性格：温柔\n- 爱好：写作"
```

- `collectMissing()` 返回引擎未能解析的标识符清单。
- `render(values)` 用于渲染提示词，用于填充标识符的 values 需由宿主提供。

## VSCODE 集成

若想在编辑 PromptScript 时获得语法高亮支持，你可以

- 使用本仓库 `vscode/` 目录下的 VS Code 插件 [.vsix](vscode/vscode-promptscript-0.0.1.vsix) ，支持 `.ps` 与 `.promptscript` 文件
- 自行打包 vsix：`cd vscode && npm install && npm run package`

## CLI

```bash
promptscript check prompt.ps # 语法/作用域检查
promptscript render prompt.ps vals.json -v user.nickname=阿月 # -v 视为字符串
```

## API

静态方法：

- `PromptScript.render(text, values?, args?, opts?)` 将传入的文本视为 PromptScript 尝试解析，不支持 `@include` 语法。
- `await PromptScript.load(path, { loadFile? })` 读文件 + 解析 + include 展开

实例方法：

- `new PromptScript(text, { loadFile?, file? })` 内存解析
- `await promptScriptInstance.resolve()` `@include` 解析（幂等）
- `promptScriptInstance.collectMissing(): string[]` 静态缺失清单
- `promptScriptInstance.render(values, args?)` 纯同步渲染；args 覆盖 values

## 许可证

Apache-2
