#!/usr/bin/env node
/**
 * 构建产物全量复验（验尸）—— 方法论沿索引文档「2026-09-28 全量重验」：
 *   1. 从 docs/*.md 的反引号片段提取标识符集合（camel/Pascal/snake，长度≥6）
 *   2. 在新构建的 zcode.cjs 与 app.asar 中逐一验尸，报告存活/消失
 *   3. 另按人工核定的「协议级事实清单」做原文子串计数（含 URL、头名、enc:v1 等非标识符串）
 * 用法:
 *   node tools/reverify_build.js [--cjs <path>] [--asar <path>] [--docs <dir>] [--out <report.md>]
 * 输出: tools/_reverify_<版本戳>.md + 控制台摘要
 */
const fs = require("fs");
const path = require("path");

const ARGS = {};
for (let i = 2; i < process.argv.length - 1; i += 2) ARGS[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const CJS = ARGS.cjs || "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const ASAR = ARGS.asar || "C:\\Program Files\\ZCode\\resources\\app.asar";
const DOCS = ARGS.docs || path.join(__dirname, "..", "docs");

// ---- 协议级事实清单（源自 09-28 重验段与各 plan 文档的关键常量，非自动提取） ----
const PROTOCOL_FACTS = [
  "zcode-plan/anthropic", "zcode-plan/billing/balance", "billing/balance", "billing/preview", "billing/claim",
  "zcodejwttoken", "zcode-api-key", "start-plan", "agent/configs", "configs.captcha",
  "zcode-v3-start-plan-0817", "api/anthropic/v1/messages", "api/v1/off-peak/anthropic",
  "x-off-peak-ticket-id", "X-Aliyun-Captcha-Verify", "enc:v1",
  "zcode:usage-entitlement:subscription-v2", "providerFamilyDomain",
  "ClientRequestSigningV4Manager", "ClientRequestSigningV4Signer", "WD_CLIENT_SIGN_KDF_SALT",
  "getSignKey_hmac", "ed25519_priv", "sanitizeClientSigningHeaders", "UNSIGNED_PATHS",
  "buildZaiStartPlan", "claimManualPlan", "getManualClaimPlanPreviews",
  "fetchZaiStartPlanBalanceEnvelope", "resolvePlanIdentitySnapshot", "resolvePlanEntitlementState",
  "entitlementCacheTtlMs", "createBigmodelOAuthClient", "loginBigmodelCodingPlan",
  "BigModelUsageQuotaProvider", "CodingPlanSubscriptionProvider", "credentialService",
  "getMachineId-win", "AliyunCaptcha", "PowVerifyString", "WEB_AES_SECRET_KEY", "FeiLin",
];

// ---- 1) 文档标识符提取 ----
const STOP = new Set(["console", "document", "window", "process", "global", "String", "Number",
  "Boolean", "Object", "Array", "Error", "RegExp", "Symbol", "Promise", "Buffer", "module",
  "exports", "require", "typeof", "instanceof", "return", "function", "default", "async",
  "await", "static", "public", "private", "readonly", "interface", "namespace", "declare",
  "implements", "extends", "undefined", "Infinity", "arguments", "localStorage",
  "sessionStorage", "headers", "payload", "version", "content", "children", "output", "input"]);

function idLike(tok) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{5,}$/.test(tok)) return false;
  if (STOP.has(tok) || STOP.has(tok[0].toLowerCase() + tok.slice(1))) return false;
  const hasUnder = tok.includes("_");
  const hasCamel = /[a-z][A-Z]/.test(tok);
  const hasPascal = /^[A-Z][a-z]/.test(tok);
  return hasUnder || hasCamel || hasPascal;
}

const identifiers = new Set();
let docFiles = 0;
for (const f of fs.readdirSync(DOCS).filter((x) => x.endsWith(".md"))) {
  docFiles++;
  const text = fs.readFileSync(path.join(DOCS, f), "utf8");
  for (const seg of text.matchAll(/`([^`\n]+)`/g)) {
    for (const piece of seg[1].split(/[\s,;:()"'=+.[\]{}<>|&!?*^%/-]+/)) {
      const tok = piece.replace(/^[^A-Za-z_$]+|[^A-Za-z0-9_$]+$/g, "");
      if (idLike(tok)) identifiers.add(tok);
    }
  }
}

// ---- 2) 读取新构建产物 ----
const cjsSrc = fs.readFileSync(CJS, "utf8");

const buf = fs.readFileSync(ASAR);
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
const header = JSON.parse(rawHeader.slice(0, end));
const contentStart = 8 + headerPickleSize;
const unpackedDir = ASAR + ".unpacked";

const files = [];
(function walk(node, prefix) {
  for (const [name, meta] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + "/" + name : name;
    if (meta.files) walk(meta, p);
    else files.push({ path: p, size: meta.size, offset: meta.offset, unpacked: !!meta.unpacked });
  }
})(header, "");

function extractText(f) {
  let b;
  if (f.unpacked) b = fs.readFileSync(path.join(unpackedDir, f.path.split("/").join(path.sep)));
  else b = buf.slice(contentStart + Number(f.offset), contentStart + Number(f.offset) + f.size);
  return b.toString("latin1");
}

// asar 自有面（out/**）与全包两套 token 集；全包 bigText 供协议级子串计数
const jsLike = (p) => /\.(js|cjs|mjs|json)$/i.test(p);
let hostText = "", allText = rawHeader.slice(0, end);
for (const f of files) {
  if (!jsLike(f.path) || f.size > 80 * 1048576) continue;
  const t = extractText(f);
  allText += "\n" + t;
  if (f.path.startsWith("out/")) hostText += "\n" + t;
}

function tokenSet(text) {
  const s = new Set();
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{5,}/g)) s.add(m[0]);
  return s;
}
const tCjs = tokenSet(cjsSrc), tHost = tokenSet(hostText), tAll = tokenSet(allText);
const countIn = (hay, needle) => {
  let n = 0, i = -1;
  while ((i = hay.indexOf(needle, i + 1)) !== -1) n++;
  return n;
};

// ---- 3) 验尸与报告 ----
const rows = { onlyCjs: [], onlyAsar: [], both: [], gone: [] };
for (const tok of identifiers) {
  const inC = tCjs.has(tok), inH = tHost.has(tok), inA = inH || tAll.has(tok);
  if (!inC && !inA) rows.gone.push(tok);
  else if (inC && inA) rows.both.push(tok);
  else if (inC) rows.onlyCjs.push(tok);
  else rows.onlyAsar.push(tok);
}
const total = identifiers.size;
const surviveEither = total - rows.gone.length;

const stamp = new Date().toISOString().slice(0, 10);
const out = ARGS.out || path.join(__dirname, `_reverify_${stamp}.md`);
const lines = [];
lines.push(`# 构建复验 · ${stamp}`);
lines.push("");
lines.push(`- cjs: \`${CJS}\`（${(fs.statSync(CJS).size / 1048576).toFixed(2)} MB）`);
lines.push(`- asar: \`${ASAR}\`（${(buf.length / 1048576).toFixed(1)} MB，${files.length} 项，jsLike 纳入文本 ${(allText.length / 1048576).toFixed(1)} MB / host 面 ${(hostText.length / 1048576).toFixed(1)} MB）`);
lines.push(`- 文档标识符 ${total} 个（来自 ${docFiles} 个 docs/*.md 反引号片段）`);
lines.push("");
lines.push(`| 存活面 | 数量 | 占比 |`);
lines.push(`|---|---|---|`);
lines.push(`| cjs+asar 双活 | ${rows.both.length} | ${(rows.both.length / total * 100).toFixed(1)}% |`);
lines.push(`| 仅 cjs | ${rows.onlyCjs.length} | ${(rows.onlyCjs.length / total * 100).toFixed(1)}% |`);
lines.push(`| 仅 asar | ${rows.onlyAsar.length} | ${(rows.onlyAsar.length / total * 100).toFixed(1)}% |`);
lines.push(`| **两产物均消失** | **${rows.gone.length}** | **${(rows.gone.length / total * 100).toFixed(1)}%** |`);
lines.push("");
lines.push(`## 两产物均消失的标识符（需逐条验尸文档）`);
lines.push("");
lines.push("```");
lines.push(rows.gone.sort().join("\n"));
lines.push("```");
lines.push("");
lines.push(`## 协议级事实计数（原文子串）`);
lines.push("");
lines.push("| 事实 | cjs | asar |");
lines.push("|---|---|---|");
for (const fact of PROTOCOL_FACTS) {
  lines.push(`| \`${fact}\` | ${countIn(cjsSrc, fact)} | ${countIn(allText, fact)} |`);
}
fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");

console.log(`标识符 ${total}：双活 ${rows.both.length}，仅cjs ${rows.onlyCjs.length}，仅asar ${rows.onlyAsar.length}，消失 ${rows.gone.length}`);
console.log(`消失率 ${(rows.gone.length / total * 100).toFixed(1)}%`);
const factsGone = PROTOCOL_FACTS.filter((f) => countIn(cjsSrc, f) === 0 && countIn(allText, f) === 0);
console.log(`协议级 0 命中：${factsGone.length ? factsGone.join(", ") : "无"}`);
console.log(`报告 -> ${out}`);
