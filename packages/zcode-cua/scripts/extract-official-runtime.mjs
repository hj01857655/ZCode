// 生成 vendor/official-runtime.js：把 ZCode 4.0.0 发行包内 node-repl-host 的
// `@zcode/zcode-cua` 编译模块区段原样取回。
//
// 为什么这样做：源码同步仓库里 packages/zcode-cua 只带 Helper 产物与占位客户端，
// 真实客户端（14 工具、BrokerClient、帧注册表、会话/动作策略）只存在于发行包。
// 发行包每个模块前保留了 `// ../../../../packages/zcode-cua/dist/...` 边界注释，
// 说明这是一次编译产物切分，而不是重写。
//
// 用法：
//   node scripts/extract-official-runtime.mjs \
//     <server.js 路径> <输出文件路径> [起始行] [结束行]
// 默认区段 67524–123738 覆盖：
//   dist/index.js（14 工具 + 客户端 SDK）
//   dist/broker/*、dist/broker/server/*（协议、Helper 启动、进程内 broker）
//   dist/pip-session/*、dist/frame-contract/*、dist/presentation/*、shared/browser-use/*
// shim 只补编译器产物依赖的两个外部名：__toESM / external_exports（zod）。
//
// express 的顶层导入被剥掉：该模块的 `import express from "express"` 在本区段内没有任何
// 使用者（发行包编译器留下的死导入），而 CLI 的 cjs 打包会把 import.meta 替换成空对象，
// 使 createRequire(import.meta.url) 在模块求值阶段直接抛
// "The argument 'filename' must be a file URL object..."——zcode.cjs 的任何子命令
// （含 app-server --prepare-storage）都会在启动前失败，桌面端表现为
// startup failed: preparing_session_storage / transport_closed。
// 发行包也不随附 express，改 require 基址无处可指，只能删除这条无引用的导入。
import { readFileSync, writeFileSync } from "node:fs";

const [srcPath, outPath, startArg, endArg] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("usage: node extract-official-runtime.mjs <server.js> <out.js> [startLine] [endLine]");
  process.exit(2);
}
const startLine = Number(startArg ?? 67524);
const endLine = Number(endArg ?? 123738);
if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
  console.error("invalid line range");
  process.exit(2);
}

const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);
let body = lines.slice(startLine - 1, endLine).join("\n");

// 死导入只删一次；出现别处引用说明上游改了使用方式，必须停下来重新判断。
const expressImport = /^var import_express = __toESM\(require_express2\(\), 1\);\n/m;
const expressRefs = body.match(/\bimport_express\b/g)?.length ?? 0;
if (expressRefs !== 1 || !expressImport.test(body)) {
  console.error(`unexpected express import shape in extracted range (refs=${expressRefs})`);
  process.exit(1);
}
body = body.replace(expressImport, "");
if (body.includes("__createRequire") || body.includes("require_express2")) {
  console.error("extracted range still references the removed express shim");
  process.exit(1);
}

const shim = `// 编译器产物依赖的外部名：ESM 互通辅助、zod 命名空间。
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
import * as __zod from "zod";
var external_exports = __zod;
`;

const header = `// @generated 由 scripts/extract-official-runtime.mjs 从 ZCode 4.0.0 发行包切出，勿手改。
// 源区段：node-repl-host/dist/mcp/server.js 第 ${startLine}–${endLine} 行。
// 重新生成：node scripts/extract-official-runtime.mjs <server.js> <本文件>
`;

// 对外导出的名字：只导出本仓包装层实际消费、且确认在区段内有顶层声明的符号。
// 编译器给同区段内重名的常量加了数字后缀（如 OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY2），
// 这里用 as 还原包内公开名。
const EXPORTS = [
  "createComputerUseRuntime",
  "startInProcessComputerUseBroker",
  "PermissionBrokerClient",
  "PermissionBrokerError",
  "BROKER_UNAVAILABLE_CODE",
  "pipSessionEventSchema",
  "BrokerError",
  "CuaHelperError",
  "notAuthorized",
  "notSelectable",
  "notSettable",
  "elementUnavailable",
  "actionUnavailable",
  "foregroundRequired",
  "parseRequestLine",
  "okResponse",
  "errorResponse",
  "errorResponseFromException",
  "serializeResponse",
  "dispatchRequest",
  "isBrokerMethod",
  "isReadOnlyBrokerMethod",
  "mintBrokerSocketPath",
  "resolveBrokerSocketPath",
  "BROKER_SOCKET_ENV",
  "IN_PROCESS_BROKER_SOCKET",
  "HELPER_APP_NAME",
  "DEV_HELPER_APP_NAME",
  "HELPER_DISPLAY_NAME",
  "HELPER_BUNDLE_ID",
  "DEV_CUA_HELPER_BUNDLE_ID",
  "HELPER_GHOST_CURSOR_OVERLAY_ARG",
  "HELPER_ADDON_ENV",
  "buildHelperOpenArgs",
  "isCuaLocalDevelopmentRuntime",
  "createCuaHelperInstaller",
  "defaultCuaHelperVerifierDependencies",
  "createAxReadOnlyMethods",
  "ROLE_TO_KIND",
  "roleToKind",
  "loadRealNativeAddon",
  "resolvePackagedNativeAddonPath",
  "resolveInTreeAddonPath",
  "resolveHelperAppName",
  "resolveCuaHelperInstallRoot",
  "standaloneHelperCandidatePaths",
  "OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES",
  "CUA_APP_ASSOCIATIONS_META_KEY",
  "CUA_APP_ASSOCIATIONS_MAX_META_BYTES",
  "CUA_REQUEST_ACCESS_STATUS_META_KEY",
  "cuaRequestAccessStatusSchema",
  "OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY2 as OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY",
  "isOfficialCuaImageRefText2 as isOfficialCuaImageRefText",
];

const declared = new Set();
for (const line of body.split("\n")) {
  const match = line.match(/^(?:var|let|const|class|function|async function) ([A-Za-z_$][\w$]*)/);
  if (match) declared.add(match[1]);
}
const missing = EXPORTS.map((entry) => entry.split(" ")[0]).filter((name) => !declared.has(name));
if (missing.length > 0) {
  console.error(`missing top-level declarations: ${missing.join(", ")}`);
  process.exit(1);
}

const footer = `\nexport {\n${EXPORTS.map((entry) => `  ${entry}`).join(",\n")}\n};\n`;

writeFileSync(outPath, `${header}${shim}${body}${footer}`, "utf8");
console.log(`wrote ${outPath}: ${body.split("\n").length} lines from ${startLine}-${endLine}, ${EXPORTS.length} exports`);