# PromptScript

[中文版本](./README.md) | English Version (You're here)

PromptScript is a lightweight templating language for orchestrating complex AI prompts, offering:

- **Conditionals**: Use `@if` with `@else` for various conditions (supports `@else @if(expr)` else-if chains)
- **Loops**: Use `@for` to iterate over record entries (`@for k, v in rec`) or integer ranges (`@for i in 1..5`), with an optional `@else` to handle empty records
- **Cross-file references**: Use `@include` to inline other files for better modularity
- **Dynamic fields**: Use `{path}` interpolation with null-safe fallbacks and ternary expressions
- **Variables**: Declare with `@set` to reduce repetition and improve readability
- **Records**: A literal type `{key: value}`
- **Pure function renderer**: `static render()`
- **Comments**: Just comments

And more, all built on principles of being **lightweight**, **concise**, and **static**, making it easy for developers to organize complex AI prompts.

> PromptScript is part of the [Shuyue Project](https://moon.chumenta.cn).

> PromptScript was implemented with assistance from Deepseek AI.

## Quick Start

```bash
$ npm i promptscript
```

```typescript
import { PromptScript } from "promptscript";

const ps = new PromptScript(`
@set tone = user.level > 50 ? "Friendly" : "kind"
// This is a comment that will be stripped during parsing
user is {user.nickname ?? "your friend"}, the tone of the reply should be{tone}。
@if (showWeather) {
  "Weather：{env.weather | Unknown}"
} @else {
  "Weather information is not allowed"
}
@for k, v in tags {
  "- {k}：{v}"
} @else {
  "No tags for this user"
}
`);

const missing = ps.collectMissing(); // missing = ["user.level", "user.nickname", "showWeather", "env.weather", "tags"]
// …… The host application should provide the missing fields
const text = ps.render({
  "user.level": 60,
  "user.nickname": "Shuyue",
  showWeather: true,
  "env.weather": undefined,
  tags: { personality: "gentle", hobby: "writing" },
});
// text = "user is Shuyue, the tone of the reply should beFriendly。\nWeather：Unknown\n- personality：gentle\n- hobby：writing"
```

- `collectMissing()` returns a list of identifiers that the engine could not resolve.
- `render(values)` is used to render the prompt; values for identifiers must be provided by the host application.

## VS Code Integration

To get syntax highlighting support while editing PromptScript files:

- Use the VS Code extension [.vsix](vscode/vscode-promptscript-0.0.1.vsix) from this repository's `vscode/` directory, which supports `.ps` and `.promptscript` files
- Build the vsix yourself: `cd vscode && npm install && npm run package`

## CLI

```bash
promptscript check prompt.ps # Syntax and scope checking
promptscript render prompt.ps vals.json -v user.nickname=阿月 # -v is treated as a string
```

## API

Static methods:

- `PromptScript.render(text, values?, args?, opts?)` Parses the given text as PromptScript; does not support `@include` syntax.
- `await PromptScript.load(path, { loadFile? })` Reads the file, parses it, and expands `@include` directives

Instance methods:

- `new PromptScript(text, { loadFile?, file? })` Parses in memory
- `await promptScriptInstance.resolve()` Resolves `@include` directives (idempotent)
- `promptScriptInstance.collectMissing(): string[]` Static list of missing identifiers
- `promptScriptInstance.render(values, args?)` Pure synchronous rendering; `args` overrides `values`

## License

Apache-2
