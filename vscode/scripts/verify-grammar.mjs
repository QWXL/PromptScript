// 语法验证：用 vscode-textmate 对规范语法文件做真实 tokenize，
// 断言注释高亮符合 docs/superpowers/specs/2026-08-19-comments-design.md 的边界用例。
// 用法：node scripts/verify-grammar.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const { Registry, INITIAL, parseRawGrammar } = textmate;
const { loadWASM, createOnigScanner, createOnigString } = oniguruma;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR_FILE = path.resolve(__dirname, '..', '..', 'syntaxes', 'promptscript.tmLanguage.json');
const WASM_FILE = path.resolve(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm');

await loadWASM(fs.readFileSync(WASM_FILE).buffer);

const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
});
const grammar = await registry.addGrammar(
  parseRawGrammar(fs.readFileSync(GRAMMAR_FILE, 'utf8'), path.basename(GRAMMAR_FILE))
);

/** 逐行 tokenize（共享 ruleStack），返回每行的 [{scope, text}] */
function tokenize(lines) {
  let stack = INITIAL;
  return lines.map((line) => {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    return r.tokens.map((t) => ({
      scope: t.scopes[t.scopes.length - 1],
      text: line.slice(t.startIndex, t.endIndex),
    }));
  });
}

const has = (toks, part) => toks.some((t) => t.scope.includes(part));
const first = (toks, part) => toks.find((t) => t.scope.includes(part));

/** 用例：{name, lines, check: (toks, name) => 失败原因 | null} */
const CASES = [
  {
    name: '行首整行 // 注释',
    lines: ['// 注释'],
    check: (t) => (has(t[0], 'comment.line') ? null : '缺少 comment.line'),
  },
  {
    name: '普通文档行不误标',
    lines: ['段落一'],
    check: (t) => (has(t[0], 'comment.') ? '误标注释' : null),
  },
  {
    name: '跨行块注释整体擦除（/* * */ 三行）',
    lines: ['/*', '*', '*/'],
    check: (t) => (t.every((x) => has(x, 'comment.block')) ? null : '某行未进入 comment.block'),
  },
  {
    name: '行首块关闭后剩余内容继续处理（/* c */ 正文）',
    lines: ['/* c */ 正文'],
    check: (t) => {
      const b = first(t[0], 'comment.block');
      const tail = t[0].filter((x) => x.text.trim() === '正文');
      const plain = tail.every((x) => !x.scope.includes('comment.'));
      return b && tail.length && plain ? null : '块关闭后正文未按普通内容处理';
    },
  },
  {
    name: '文章行中间 http://a//b 原样',
    lines: ['访问 http://a//b'],
    check: (t) => (has(t[0], 'comment.') ? 'http:// 被误标注释' : null),
  },
  {
    name: '行首转义 \\// 不是注释',
    lines: ['\\// 代码注释'],
    check: (t) => {
      const esc = first(t[0], 'constant.character.escape');
      return esc && !has(t[0], 'comment.') ? null : `转义未生效（escape=${!!esc}）`;
    },
  },
  {
    name: '@set 行尾部 // 注释',
    lines: ['@set x = a // 说明'],
    check: (t) => {
      if (!has(t[0], 'comment.line')) return '缺少尾部注释高亮';
      if (!has(t[0], 'keyword.control')) return '@set 关键词丢失';
      return null;
    },
  },
  {
    name: '@if(a) { // 说明 尾部注释',
    lines: ['@if(a) { // 说明'],
    check: (t) => (has(t[0], 'comment.line') ? null : '缺少尾部注释高亮'),
  },
  {
    name: '代码模式字符串行 "文本" // 说明',
    lines: ['"文本" // 说明'],
    check: (t) => {
      if (!has(t[0], 'string.quoted.double')) return '字符串高亮丢失';
      return has(t[0], 'comment.line') ? null : '缺少尾部注释高亮';
    },
  },
  {
    name: '代码模式字符串行 单引号',
    lines: ["'文本' // 说明"],
    check: (t) => (has(t[0], 'comment.line') ? null : '缺少尾部注释高亮'),
  },
  {
    name: '} 闭合行尾部注释',
    lines: ['} // 说明'],
    check: (t) => (has(t[0], 'comment.line') ? null : '缺少尾部注释高亮'),
  },
  {
    name: '字符串内 // 不识别（@set x = "a//b"）',
    lines: ['@set x = "a//b"'],
    check: (t) => {
      if (!has(t[0], 'string.quoted.double')) return '字符串高亮丢失';
      return has(t[0], 'comment.') ? '字符串内 // 被误标注释' : null;
    },
  },
  {
    name: '指令行行内 /* */ 块（可多对）',
    lines: ['@set x = a /* c */ b /* d */'],
    check: (t) => (has(t[0], 'comment.block') ? null : '缺少行内块注释高亮'),
  },
  {
    name: '行内未闭合 /* 高亮到行尾（静态语法近似，解析器会报 E_COMMENT_UNCLOSED）',
    lines: ['@set x = a /* 未闭合'],
    check: (t) => (has(t[0], 'comment.block') ? null : '首行未进入块注释'),
  },
  {
    name: '行首孤立 */ 报错高亮',
    lines: ['*/ 孤立'],
    check: (t) => (has(t[0], 'invalid.illegal.stray-comment-end') ? null : '缺少 stray 错误高亮'),
  },
  {
    name: '槽位内 // 不识别（{a // b}）',
    lines: ['{a // b}'],
    check: (t) => (has(t[0], 'comment.') ? '槽位内 // 被误标注释' : null),
  },
  {
    name: '指令行关键词高亮保持',
    lines: ['@set x = 1'],
    check: (t) => (has(t[0], 'keyword.control') ? null : '关键词高亮丢失'),
  },
  {
    name: '非法指令 @foo 标错',
    lines: ['@foo bar'],
    check: (t) => (has(t[0], 'invalid.illegal') ? null : '缺少非法指令高亮'),
  },
  {
    name: '指令行行首转义 a \\// c 不截断',
    lines: ['@set x = a \\// c'],
    check: (t) => (has(t[0], 'comment.') ? '转义后的 // 被误标注释' : null),
  },
  {
    name: '块后行注释 /* c */ // note 整行注释',
    lines: ['/* c */ // note'],
    check: (t) => (has(t[0], 'comment.line') ? null : '缺少行注释高亮'),
  },
];

let failed = 0;
for (const c of CASES) {
  const toks = tokenize(c.lines);
  const err = c.check(toks);
  if (err) {
    failed++;
    console.log(`FAIL  ${c.name}\n      ${err}`);
    toks.forEach((t, i) =>
      console.log(`      [${c.lines[i]}] -> ${t.map((x) => `${x.scope.split('.').slice(-1)[0]}:${x.text}`).join(' | ') || '(无 token)'}`)
    );
  } else {
    console.log(`PASS  ${c.name}`);
  }
}
console.log(failed === 0 ? `\n全部 ${CASES.length} 个用例通过` : `\n${failed}/${CASES.length} 个用例失败`);
// 用 exitCode 自然退出而非 process.exit()：后者会在 oniguruma wasm 线程收尾前强退，
// 触发 Windows 上 libuv 的 UV_HANDLE_CLOSING 断言（退出码被 abort 覆盖为 127）。
process.exitCode = failed === 0 ? 0 : 1;
