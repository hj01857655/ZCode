#!/usr/bin/env node
/** 打印 rollout 一行的结构：顶层键 / response 键 / request.body 键 / messages 条数与 role 分布。 */
const fs = require("fs"), os = require("os"), path = require("path");
const D = path.join(os.homedir(), ".zcode", "cli", "rollout");
const files = fs.readdirSync(D).filter((x) => x.endsWith(".jsonl"))
  .map((x) => path.join(D, x))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
console.log("文件 %d 个，最大 %s (%s MB)\n", files.length,
  path.basename(files[0]), (fs.statSync(files[0]).size / 1048576).toFixed(2));

const lines = fs.readFileSync(files[0], "utf8").split(/\r?\n/).filter(Boolean);
console.log("行数 %d\n", lines.length);

const o = JSON.parse(lines[8]);
const keys = (x) => (x && typeof x === "object" ? Object.keys(x).join(", ") : "(无)");
console.log("顶层键        : " + keys(o));
console.log("response 键   : " + keys(o.response));
console.log("request 键    : " + keys(o.request));
console.log("request.body  : " + keys(o.request && o.request.body).slice(0, 240));

const msgs = (o.request && o.request.body && o.request.body.messages) || [];
console.log("\nmessages 条数 : " + msgs.length);
const roles = {};
msgs.forEach((m) => { roles[m.role] = (roles[m.role] || 0) + 1; });
console.log("role 分布     : " + JSON.stringify(roles));
console.log("content 形态  : " + JSON.stringify(msgs.slice(0, 3).map((m) => ({
  role: m.role,
  contentTypes: Array.isArray(m.content) ? m.content.map((c) => c.type) : typeof m.content,
}))));

// response 里所有字符串字段
function strs(x, p = "", out = []) {
  if (typeof x === "string") out.push(p);
  else if (Array.isArray(x)) x.forEach((v, i) => strs(v, p + "[" + i + "]", out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) strs(v, p + "." + k, out);
  return out;
}
console.log("\nresponse 内字符串字段:");
[...new Set(strs(o.response).map((p) => p.replace(/\[\d+\]/g, "[]")))].forEach((p) => console.log("  " + p));
