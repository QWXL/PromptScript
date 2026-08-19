export type ErrorStage = "parse" | "load" | "render";

export interface PromptScriptErrorOptions {
  stage: ErrorStage;
  file: string;
  line: number;
  code: string;
  message: string;
}

export class PromptScriptError extends Error {
  readonly stage: ErrorStage;
  readonly file: string;
  readonly line: number;
  readonly code: string;

  constructor(opts: PromptScriptErrorOptions) {
    super(`${opts.file}:${opts.line}: [${opts.code}] ${opts.message}`);
    this.name = "PromptScriptError";
    this.stage = opts.stage;
    this.file = opts.file;
    this.line = opts.line;
    this.code = opts.code;
  }

  override toString(): string {
    return this.message;
  }
}

export function psError(
  stage: ErrorStage,
  file: string,
  line: number,
  code: string,
  message: string,
): PromptScriptError {
  return new PromptScriptError({ stage, file, line, code, message });
}
