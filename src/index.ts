import { readFileSync } from "node:fs";
import { parseDocument, resolveIncludes, type Document, type LoadFile, type Node } from "./parser.js";
import { renderDocument, collectMissing, type PSValue } from "./evaluator.js";
import { psError } from "./errors.js";

export type PromptValues = Record<string, PSValue>;
export { PromptScriptError, psError, type ErrorStage } from "./errors.js";
export type { PSValue } from "./evaluator.js";
export { parseToPSValue } from "./evaluator.js";

const defaultLoadFile: LoadFile = (p) => readFileSync(p, "utf8");

// 对行树（块递归）做谓词检查：hasInclude（resolve）与未解析守卫（guardResolved）共用一条遍历
function anyNode(lines: Node[], test: (n: Node) => boolean): boolean {
  return lines.some((n) =>
    test(n) ||
    (n.type === "block" && (anyNode(n.ifLines, test) || anyNode(n.elseLines ?? [], test))) ||
    (n.type === "for" && (anyNode(n.body, test) || anyNode(n.elseLines ?? [], test))));
}

export class PromptScript {
  private readonly doc: Document;
  private readonly loadFile?: LoadFile;
  private resolved = false;

  constructor(text: string, opts: { loadFile?: LoadFile; file?: string } = {}) {
    this.doc = parseDocument(text, opts.file ?? "");
    this.loadFile = opts.loadFile;
  }

  // 偏差注：brief 原文 readFileSync(path) 与自身测试矛盾——测试用内存 fs（/t/main.ps 不存在于磁盘）。
  // 最小修复：优先经 loadFile 读主文件（含默认 readFileSync），语义"readFile → new → resolve"不变。
  static async load(path: string, opts: { loadFile?: LoadFile } = {}): Promise<PromptScript> {
    const loadFile = opts.loadFile ?? defaultLoadFile;
    const text = await loadFile(path);
    const ps = new PromptScript(text, { file: path, loadFile });
    await ps.resolve();
    return ps;
  }

  async resolve(): Promise<void> {
    if (this.resolved) return;
    if (!this.loadFile && anyNode(this.doc.lines, (n) => n.type === "include")) {
      throw psError("load", this.doc.file, 0, "E_INCLUDE_NO_LOADER",
        "文档包含 @include 但未提供 loadFile；请传入 { loadFile } 或使用 PromptScript.load");
    }
    if (this.loadFile) await resolveIncludes(this.doc, this.loadFile);
    this.resolved = true;
  }

  collectMissing(): string[] {
    this.guardResolved();
    return collectMissing(this.doc);
  }

  render(values: PromptValues, args: PromptValues = {}): string {
    this.guardResolved();
    return renderDocument(this.doc, { ...values, ...args });
  }

  static async render(
    text: string,
    values: PromptValues = {},
    args: PromptValues = {},
    opts: { loadFile?: LoadFile } = {},
  ): Promise<string> {
    const ps = new PromptScript(text, { loadFile: opts.loadFile });
    // 无 loadFile 且含 @include → resolve() 自然抛 E_INCLUDE_NO_LOADER（清晰错误透传）
    await ps.resolve();
    return ps.render(values, args);
  }

  private guardResolved(): void {
    if (this.resolved) return;
    if (anyNode(this.doc.lines, (n) => n.type === "include" && n.doc === null)) {
      throw psError("render", this.doc.file, 0, "E_UNRESOLVED",
        "文档包含未解析的 @include：请先 await ps.resolve()");
    }
    // fix 6：守卫方法不再变更状态——resolved 仅由 resolve() 置位，resolve() 失败后的重试路径不受污染
  }
}
