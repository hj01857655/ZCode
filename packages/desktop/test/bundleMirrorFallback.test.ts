import { describe, expect, it, vi } from "vitest";

// 模拟未配置内网依赖源的构建环境（例如开源构建）：内网地址解析抛错。
vi.mock("../../../scripts/intranetDefaults.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntranetDepsBaseUrl: () => {
    throw new Error("Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST");
  },
}));

const {
  OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR,
  createBundleProcessEnvs,
  resolveBundleZCodeEnv,
  resolveElectronBuilderBinariesMirror,
} = await import("../scripts/bundle.mjs");
const { resolveDesktopProductIdentity } = await import("../scripts/desktop-product-identity.mjs");

describe("未配置内网依赖源时的 electron-builder binaries 镜像", () => {
  it("回退到官方 release 下载地址，打包不因内网地址缺失而失败", () => {
    expect(resolveElectronBuilderBinariesMirror({})).toBe(
      OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR,
    );
  });

  it("显式配置的镜像仍然优先", () => {
    expect(
      resolveElectronBuilderBinariesMirror({
        ELECTRON_BUILDER_BINARIES_MIRROR: "https://example.test/electron-builder-binaries/",
      }),
    ).toBe("https://example.test/electron-builder-binaries/");
  });
});

describe("桌面打包默认生产身份", () => {
  it("未设置 ZCODE_ENV 或设置为未知值时均按 production 打包", () => {
    expect(resolveBundleZCodeEnv({})).toBe("production");
    expect(resolveBundleZCodeEnv({ ZCODE_ENV: "staging" })).toBe("production");
  });

  it("只有显式 ZCODE_ENV=test 才进入测试环境", () => {
    expect(resolveBundleZCodeEnv({ ZCODE_ENV: "test" })).toBe("test");
    expect(resolveBundleZCodeEnv({ ZCODE_ENV: "production" })).toBe("production");
  });

  it("build 与 electron-builder 子进程拿到同一个环境值", () => {
    const baseArgs = {
      os: "win" as const,
      arch: "x64" as const,
      electronMirror: "",
      electronBuilderMirror: "",
    };
    expect(createBundleProcessEnvs(baseArgs).buildEnv.ZCODE_ENV).toBe(
      resolveBundleZCodeEnv(process.env),
    );
    expect(createBundleProcessEnvs(baseArgs).electronBuilderEnv.ZCODE_ENV).toBe(
      resolveBundleZCodeEnv(process.env),
    );
  });

  it("默认生产环境解析为 ZCode 身份，显式 test 才落到 Preview", () => {
    const toIdentity = (zcodeEnv) =>
      resolveDesktopProductIdentity({ ...process.env, ZCODE_ENV: zcodeEnv });
    expect(toIdentity(resolveBundleZCodeEnv({})).productName).toBe("ZCode");
    expect(toIdentity(resolveBundleZCodeEnv({ ZCODE_ENV: "test" })).productName).toBe(
      "ZCode Preview",
    );
    expect(
      resolveDesktopProductIdentity({
        ZCODE_ENV: "production",
        ZCODE_PREVIEW_IDENTITY: "1",
      }).productName,
    ).toBe("ZCode Preview");
  });
});
