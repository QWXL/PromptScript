#!/usr/bin/env node
import { runCLI } from "../src/cli.js";

const code = await runCLI(process.argv.slice(2), {
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
// fix 3：process.exit(code) 会截断未 flush 的 stdout——改用 exitCode 让进程自然退出（stdin 已耗尽、无悬挂句柄）
process.exitCode = code;
