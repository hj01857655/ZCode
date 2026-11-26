import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareWindowsCuaHelperAssets,
  verifyPackagedWindowsCuaHelper,
} from "../scripts/windows-cua-helper-assets.mjs";

const roots: string[] = [];
const targetPlatform = { os: "win32", arch: "x64", key: "win32-x64" };
const electronVersion = "44.7.0";

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// 只校验 PE 机器类型（0x8664 = x64），addon 其余内容不参与契约。
function createFakePe(): Buffer {
  const bytes = Buffer.alloc(0x100);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\u0000\u0000", 0x40, "binary");
  bytes.writeUInt16LE(0x8664, 0x44);
  return bytes;
}

function createProducer(extraManifest: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "zcode-cua-producer-assets-"));
  roots.push(root);
  const sourceRoot = join(root, "producer");
  mkdirSync(join(sourceRoot, "build", "Release"), { recursive: true });
  writeFileSync(
    join(sourceRoot, "package.json"),
    JSON.stringify({
      name: "@zcode/zcode-cua",
      version: "0.6.6",
      zcodeCuaRuntime: {
        schema: 1,
        windows: { entry: "windows-helper.js", nativeAddon: "build/Release/ax_native.node" },
      },
      ...extraManifest,
    }),
  );
  writeFileSync(join(sourceRoot, "windows-helper.js"), "export {};\n");
  writeFileSync(join(sourceRoot, "build", "Release", "ax_native.node"), createFakePe());
  return { root, sourceRoot };
}

describe("Windows CUA Helper 打包暂存", () => {
  it("entry 自包含时暂存只带 entry/addon，并把空依赖闭包写进运行时清单", async () => {
    const { root, sourceRoot } = createProducer({ zcodeCuaHelperRuntimeDependencies: [] });
    const outputRoot = join(root, "bundled-tools");
    const result = await prepareWindowsCuaHelperAssets({
      sourceRoot,
      outputRoot,
      targetPlatform,
      electronVersion,
    });

    expect(result.status).toBe("staged");
    // 产物自带的 module 声明必须同时记录依赖闭包，afterPack 才能在缺少 producer 清单时校验。
    const runtimePackage = JSON.parse(
      readFileSync(join(result.outputDir, "package.json"), "utf8"),
    );
    expect(runtimePackage).toMatchObject({ type: "module", runtimeDependencies: [] });

    const resourcesDir = join(root, "resources");
    cpSync(result.outputDir, join(resourcesDir, "tools", "cua-helper"), {
      recursive: true,
      dereference: true,
    });
    await expect(
      verifyPackagedWindowsCuaHelper({ resourcesDir, targetPlatform, electronVersion }),
    ).resolves.toMatchObject({ status: "verified" });
  });

  it("声明了未安装的 Helper 运行时依赖时暂存失败，而不是产出残缺安装包", async () => {
    const { root, sourceRoot } = createProducer({
      zcodeCuaHelperRuntimeDependencies: ["zcode-cua-test-missing-dependency"],
    });
    await expect(
      prepareWindowsCuaHelperAssets({
        sourceRoot,
        outputRoot: join(root, "bundled-tools"),
        targetPlatform,
        electronVersion,
      }),
    ).rejects.toThrow(/missing runtime dependency/u);
  });
});