const fs = require('fs');
const path = require('path');
const DIR = 'E:\\VSCodeSpace\\ZCode\\docs';
let bad = 0;
for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.md'))) {
  const raw = fs.readFileSync(path.join(DIR, f));
  const text = raw.toString('utf8');
  const lines = text.split('\n');
  const issues = [];

  const fences = lines.filter(l => /^\s*```/.test(l)).length;
  if (fences % 2 !== 0) issues.push('代码围栏不配对 (' + fences + ')');
  if (raw[0] === 0xef) issues.push('有 BOM');
  if (text.includes('\r')) issues.push('含 CR');

  // 相对链接可达
  for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(#[^)\s]*)?\)/g)) {
    if (!fs.existsSync(path.join(DIR, m[1]))) issues.push('链接缺失: ' + m[1]);
  }
  // 表格列数
  lines.forEach((l, i) => {
    if (/^\|[\s:-]+\|/.test(l)) {
      const cols = l.replace(/\\\|/g, '\u0000').split('|').length - 2;
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('|')) {
        if (lines[j].replace(/\\\|/g, '\u0000').split('|').length - 2 !== cols) issues.push('表列数不符 L' + (j + 1));
        j++;
      }
    }
  });
  // 锚点：文内 #fragment 引用能否对上本文件标题（GitHub slugger: 保留 \p{L}\p{N}、空格、连字符）
  const anchors = new Set(lines.filter(l => /^#{1,3} /.test(l)).map(h =>
    '#' + h.replace(/^#{1,3} /, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')   // 去掉 . ` （） 等标点，\p{L} 含 CJK；_ 保留
      .trim()
      .replace(/\s+/g, '-')
  ));
  for (const m of text.matchAll(/\]\((#[^)\s]+)\)/g)) {
    if (!anchors.has(m[1])) issues.push('锚点未匹配: ' + m[1]);
  }

  if (issues.length) { bad++; console.log('FAIL ' + f + '\n   ' + issues.join('\n   ')); }
  else console.log('OK   ' + f + '  (' + lines.length + ' 行)');
}
console.log(bad === 0 ? '\n全部通过' : '\n' + bad + ' 个文件有问题');
