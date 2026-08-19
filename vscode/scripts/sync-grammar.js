// 将规范语法文件（../syntaxes/promptscript.tmLanguage.json）
// 同步为本扩展自包含的副本，确保 vsix 打包时语法文件可独立分发。
// 用法：node scripts/sync-grammar.js
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = path.resolve(__dirname, '..', '..', 'syntaxes', 'promptscript.tmLanguage.json');
const TARGET = path.resolve(__dirname, '..', 'syntaxes', 'promptscript.tmLanguage.json');

if (!fs.existsSync(SOURCE)) {
  console.error(`[sync-grammar] 未找到规范语法文件：${SOURCE}`);
  process.exit(1);
}

const content = fs.readFileSync(SOURCE, 'utf8');

// 写入前校验 JSON 合法性，避免把损坏的语法打进 vsix
try {
  JSON.parse(content);
} catch (err) {
  console.error('[sync-grammar] 语法文件不是合法 JSON，已中止：', err.message);
  process.exit(1);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, content, 'utf8');
console.log(`[sync-grammar] 已同步：${SOURCE} -> ${TARGET}`);
