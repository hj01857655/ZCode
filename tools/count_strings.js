#!/usr/bin/env node
/**
 * 多文件 × 多模式子串计数 —— 构建更新后的定点核对（比 grab.js 的窗口抽样更适合"存活/迁移"判别）。
 * 用法:
 *   node tools/count_strings.js [--add <pat>]… [file …]      # 无 file 时用内置目标集
 * 输出: 模式 × 文件 的计数表。文件整体载入内存，单模式 O(n)。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const argv = process.argv.slice(2);
const extra = [];
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--add") extra.push(argv[++i]);
  else files.push(argv[i]);
}

const DEFAULT_FILES = {
  cjs: "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
  host: path.join(__dirname, "_asar_host_index.js"),
  cfgDefault: "C:\\Program Files\\ZCode\\resources\\config\\default.json",
  cfgBuiltin: "C:\\Program Files\\ZCode\\resources\\config\\provider\\zcode-builtin.json",
  log: path.join(os.homedir(), ".zcode", "v2", "logs", new Date().toISOString().slice(0, 10) + ".log"),
  providerConfig: path.join(os.homedir(), ".zcode", "v2", "provider_config.json"),
  setting: path.join(os.homedir(), ".zcode", "v2", "setting.json"),
};

const PATTERNS = [
  // 协议 URL 形态（判别"字面量 vs 分段拼装"）
  "api/anthropic/v1/messages", "anthropic/v1/messages", "/v1/messages",
  "chat/completions", "off-peak/anthropic", "zcode-plan", "api/pa/hub",
  // 权益/计划矩阵（01 号文档口径）与 3.15.x 配置面新家族
  "start-plan", "highspeed", "high-speed", "offpeak", "off-peak",
  "zcode-v3-start-plan", "Weekend", "GLM-5.3",
  // OAuth 命名族（09-28 复验点名 createBigmodelOAuthClient，3.15.1 cjs 0 命中，查去向）
  "BigmodelOAuth", "createBigmodel", "Bigmodel", "bigmodel", "ZaiCliOAuth",
  // 领取/计费函数族（09-28 定性：收敛 host）
  "claimManualPlan", "getManualClaimPlanPreviews", "buildZaiStartPlan",
  "fetchZaiStartPlanBalanceEnvelope", "billing/balance", "billing/claim", "billing/preview",
  // V4 签名（05 号）
  "ClientRequestSigningV4", "UNSIGNED_PATHS", "signing",
  // 凭证/存储
  "enc:v1", "zcodejwttoken",
  // 工具版本面
  "3.15.1", "zcode-cli",
];
if (extra.length) PATTERNS.push(...extra);

const loaded = {};
for (const [k, p] of Object.entries(files.length ? Object.fromEntries(files.map((f) => [path.basename(f), f])) : DEFAULT_FILES)) {
  try { loaded[k] = fs.readFileSync(p, "utf8"); }
  catch (e) { console.error(`跳过 ${k}: ${p} (${e.code || e.message})`); }
}
const names = Object.keys(loaded);
const count = (hay, needle) => { let n = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) !== -1) n++; return n; };

console.log("| pattern | " + names.join(" | ") + " |");
console.log("|---|" + names.map(() => "---|").join(""));
for (const pat of PATTERNS) {
  console.log(`| ${pat} | ` + names.map((k) => count(loaded[k], pat)).join(" | ") + " |");
}
