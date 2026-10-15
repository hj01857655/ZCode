// 从 minified bundle 里抽取关键字周边窗口，人工核对文档结论。
// 用法：node tools/grab.js <关键字> [窗口大小] [最大片段数]
//      ZCODE_CJS=<路径> 可换目标文件（默认 zcode.cjs，也可指向 asar 解出的 host/index.js）
const fs = require("fs");

// 2026-10-13：3.15.1 起安装迁移至机器级 Program Files（旧 %LOCALAPPDATA%\Programs\ZCode 已清空）
const Z = process.env.ZCODE_CJS ||
  "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";

const [kw, winArg, maxArg] = process.argv.slice(2);
const WIN = parseInt(winArg || "900", 10);
const MAX = parseInt(maxArg || "4", 10);

if (!kw) { console.error("用法: node tools/grab.js <关键字> [窗口] [上限]"); process.exit(1); }
if (!fs.existsSync(Z)) { console.error("找不到 " + Z); process.exit(1); }

const src = fs.readFileSync(Z, "utf8");
console.log(`bundle: ${Z}`);
console.log(`大小: ${(src.length / 1048576).toFixed(1)} MB`);
console.log(`关键字 "${kw}"  窗口 ±${WIN}  上限 ${MAX}\n`);

let i = 0, n = 0, total = 0;
while (n < MAX) {
  const at = src.indexOf(kw, i);
  if (at === -1) break;
  total++;
  const from = Math.max(0, at - WIN);
  const to = Math.min(src.length, at + kw.length + WIN);
  // 行号：minified 基本单行，用字节偏移代替
  const line = src.slice(0, at).split("\n").length;
  console.log("=".repeat(78));
  console.log(`片段 ${++n}  偏移 ${at}  第 ${line} 行`);
  console.log("=".repeat(78));
  console.log(src.slice(from, to));
  console.log();
  i = at + kw.length;
}
console.log(`命中 ${total} 处，展示 ${n} 处`);
