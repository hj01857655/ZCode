#!/usr/bin/env node
/**
 * 最小 asar 读取器 —— 只解析头部 + 按需抽取文件，不解包整个 archive。
 * asar 布局：4B|4B|4B|4B pickle 头 → JSON 目录 → 8 字节对齐的文件内容
 *
 *   node _re/asar_pick.js list [关键字]
 *   node _re/asar_pick.js get  <路径> [输出文件]
 *   node _re/asar_pick.js find <关键字>
 */
const fs = require("fs");
const path = require("path");

const ASAR = process.env.ASAR_PATH ||
  "C:\\Users\\12925\\AppData\\Local\\Programs\\ZCode\\resources\\app.asar";
const [cmd, ...rest] = process.argv.slice(2);

if (!fs.existsSync(ASAR)) { console.error("找不到 " + ASAR); process.exit(1); }
const buf = fs.readFileSync(ASAR);

// 头解析 —— headerStringSize 常大于实际 JSON，需按括号深度截断（尾部有 \0 填充）
const headerPickleSize = buf.readUInt32LE(4);
const headerStringSize = buf.readUInt32LE(8);
const rawHeader = buf.toString("utf8", 16, 16 + headerStringSize);
let depth = 0, end = -1, inStr = false, esc = false;
for (let i = 0; i < rawHeader.length; i++) {
  const ch = rawHeader[i];
  if (esc) { esc = false; continue; }
  if (ch === "\\") { esc = true; continue; }
  if (ch === '"') { inStr = !inStr; continue; }
  if (inStr) continue;
  if (ch === "{") depth++;
  else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error("未能定位 JSON 结尾"); process.exit(1); }
const header = JSON.parse(rawHeader.slice(0, end));
const contentStart = 8 + headerPickleSize;
console.log("app.asar  %s MB", (buf.length / 1048576).toFixed(1));
console.log("目录 %d 项，JSON %d KB（声明 %d KB，尾部填充 %d B）\n",
  Object.keys(header.files).length, end / 1024, headerStringSize / 1024, rawHeader.length - end);

// 展平目录
const files = [];
(function walk(node, prefix) {
  for (const [name, meta] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + "/" + name : name;
    if (meta.files) walk(meta, p);
    else files.push({ path: p, size: meta.size, offset: meta.offset, unpacked: !!meta.unpacked });
  }
})(header, "");

function extract(f) {
  if (f.unpacked) {
    const side = ASAR + ".unpacked" + path.sep + f.path.replace(/\//g, path.sep);
    return fs.readFileSync(side);
  }
  const start = contentStart + Number(f.offset);
  return buf.slice(start, start + f.size);
}

if (cmd === "list") {
  const kw = rest[0];
  const hit = kw ? files.filter((f) => f.path.toLowerCase().includes(kw.toLowerCase())) : files;
  console.log("%d 个文件%s", hit.length, kw ? " 匹配 \"" + kw + "\"" : "");
  hit.sort((a, b) => b.size - a.size).slice(0, 60)
    .forEach((f) => console.log("  " + String(f.size).padStart(9) + "  " + f.path));
} else if (cmd === "get") {
  const f = files.find((x) => x.path === rest[0] || x.path.endsWith(rest[0]));
  if (!f) { console.error("未找到 " + rest[0]); process.exit(1); }
  const out = rest[1] || path.join(__dirname, "_asar_" + path.basename(f.path));
  fs.writeFileSync(out, extract(f));
  console.log("已抽取 %s  (%d B) -> %s", f.path, f.size, out);
} else if (cmd === "find") {
  // 多关键词全包扫描：find <kw1> <kw2> …
  const SKIP = /\.(wasm|exe|dll|png|jpe?g|svg|json|node|ttf|woff2?|bcmap|dat|icns|bin|zip|gz|mp4|webm|ico)$/i;
  // 注意 size 阈值：getMachineId-win.js 只有 1012 B，阈值设 1024 会把它整个滤掉
  const cands = files.filter((f) => !SKIP.test(f.path) && f.size > 200);
  console.log("候选文件 %d 个（已排除二进制/资源）\n", cands.length);
  for (const kw of rest) {
    const hits = [];
    for (const f of cands) {
      let s;
      try { s = extract(f).toString("utf8"); } catch (e) { continue; }
      let n = 0, i = -1;
      while ((i = s.indexOf(kw, i + 1)) !== -1) n++;
      if (n) hits.push([f.path, f.size, n]);
    }
    console.log("=== %s ===  命中 %d 个文件", kw, hits.length);
    hits.sort((a, b) => b[2] - a[2]).forEach(([p, sz, n]) =>
      console.log("  " + p.padEnd(58) + String(sz).padStart(9) + " B  x" + n));
    console.log("");
  }
} else if (cmd === "root") {
  // 读根级 package.json（get 的 endsWith 会误匹配 node_modules 里的同名文件）
  const f = header.files["package.json"];
  if (!f) { console.error("根级无 package.json"); process.exit(1); }
  const p = JSON.parse(extract(f).toString("utf8"));
  console.log("name    : " + p.name);
  console.log("version : " + p.version);
  console.log("build   : " + (p.build || "—"));
  console.log("main    : " + p.main);
  const deps = p.dependencies || {};
  Object.keys(deps).filter((d) => /opentelemetry|arms|aliyun|captcha/i.test(d))
    .forEach((d) => console.log("dep     : " + d + "@" + deps[d]));
  console.log("\n总依赖数 " + Object.keys(deps).length);
} else {
  console.log("用法: asar_pick.js list|root|get|find …");
}
