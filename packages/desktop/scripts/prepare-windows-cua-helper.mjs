#!/usr/bin/env node

import process from "node:process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareWindowsCuaHelperAssets,
  resolveWindowsCuaHelperSourceRoot,
} from "./windows-cua-helper-assets.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDir, "..");
const servicesPackageRoot = resolve(desktopPackageRoot, "..", "services");
const targetPlatform = getTargetPlatform();

if (targetPlatform.os !== "win32") {
  console.log("[prepare-windows-cua-helper] skip unsupported platform");
  process.exit(0);
}

const desktopPackage = JSON.parse(
  await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
);
const sourceRoot = await resolveWindowsCuaHelperSourceRoot({
  runtimePackageDir: process.env.ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR,
  devRoot: process.env.ZCODE_CUA_DEV_ROOT,
  servicesPackageRoot,
});

// addon 是契约必检产物，随源码分发；缺失即失败，不能现场编译——自研构建会覆盖官方原件。
const sourcePackage = JSON.parse(await readFile(resolve(sourceRoot, "package.json"), "utf8"));
const addonRelativePath = sourcePackage.zcodeCuaRuntime?.windows?.nativeAddon;
if (typeof addonRelativePath === "string" && !existsSync(resolve(sourceRoot, ...addonRelativePath.split("/")))) {
  throw new Error(
    `[prepare-windows-cua-helper] missing ${addonRelativePath} in ${sourceRoot}`,
  );
}

const result = await prepareWindowsCuaHelperAssets({
  sourceRoot,
  outputRoot: resolve(desktopPackageRoot, "bundled-tools"),
  targetPlatform,
  electronVersion: desktopPackage.devDependencies.electron,
});

console.log(
  `[prepare-windows-cua-helper] staged ${result.manifest.packageVersion} ${result.manifest.platform}/${result.manifest.arch} PE=0x${result.peMachine.toString(16)} -> ${result.outputDir}`,
);
