export type Pos = { file: string; line: number };

// 注：brief Interfaces 节要求 ast.ts 同时导出 Mode（lexer.ts 导入），补入此处
export type Mode = "article" | "code";

export type Expr =
  | { kind: "path"; name: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "interp"; parts: (string | Expr)[] }
  | { kind: "record"; entries: [string, string | number | boolean | null][] }
  | { kind: "coalesce"; left: Expr; right: Expr }
  | { kind: "cond"; test: Expr; yes: Expr; no: Expr }
  | { kind: "compare"; op: "==" | "!=" | "<" | ">"; left: Expr; right: Expr }
  | { kind: "logical"; op: "&&" | "||"; left: Expr; right: Expr }
  | { kind: "not"; operand: Expr }
  | { kind: "index"; obj: Expr; index: Expr };
