import { spawnSync } from "node:child_process";
import { rmSync, renameSync } from "node:fs";
import { access, rm } from "node:fs/promises";

export const ASAR_UNPACK_NATIVE_GLOB = "*.{node,dll,dylib,exe}";

const ASAR_REPLACE_RETRY_COUNT = 10;
const ASAR_REPLACE_RETRY_DELAY_MS = 1_000;

// Windows 上扫描器（Defender / 第三方 AV / Everything）可能在 asar 解包、打包完成后短暂持有
// 文件句柄，让 fs.rm 抛 EBUSY。对同一路径做有限次退避重试即可释放，不能因为瞬时锁把整轮打包判死。
function retryOnWindowsFileLock(operation, pathLabel) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      const locked =
        error &&
        (error.code === "EBUSY" ||
          error.code === "EPERM" ||
          /EBUSY|EPERM|resource busy or locked|permission denied/i.test(String(error.message)));
      if (!locked || attempt >= ASAR_REPLACE_RETRY_COUNT) {
        throw error;
      }
      console.log(
        `[asar-repack] ${pathLabel} locked, retry ${attempt}/${ASAR_REPLACE_RETRY_COUNT} after ${ASAR_REPLACE_RETRY_DELAY_MS}ms`,
      );
      spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ASAR_REPLACE_RETRY_DELAY_MS})`], {
        stdio: "ignore",
      });
    }
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createAppAsarPackArgs({ sourceDir, destinationPath, targetPlatformKey }) {
  return [
    "pack",
    sourceDir,
    destinationPath,
    "--unpack",
    ASAR_UNPACK_NATIVE_GLOB,
    "--unpack-dir",
    `node_modules/node-pty/prebuilds/${targetPlatformKey}`,
  ];
}

export async function replaceAppAsarFromStaging({
  sourceDir,
  appAsarPath,
  targetPlatformKey,
  runAsarCommand,
}) {
  const candidateAsarPath = `${appAsarPath}.next`;
  const candidateUnpackedPath = `${candidateAsarPath}.unpacked`;
  const unpackedPath = `${appAsarPath}.unpacked`;

  await Promise.all([
    rm(candidateAsarPath, { force: true, recursive: true }),
    rm(candidateUnpackedPath, { force: true, recursive: true }),
  ]);

  try {
    runAsarCommand(
      createAppAsarPackArgs({
        sourceDir,
        destinationPath: candidateAsarPath,
        targetPlatformKey,
      }),
    );

    if (!(await pathExists(candidateAsarPath)) || !(await pathExists(candidateUnpackedPath))) {
      // CI 的 TMPDIR 位于隐藏目录 `.tmp`。旧 glob 含 `**/`，@electron/asar 用绝对路径
      // 匹配时不会跨过隐藏目录，导致 native 被写回 asar，同时遗留旧 unpacked 形成物理双份。
      throw new Error(`重打包结果缺少 app.asar 或 app.asar.unpacked: ${candidateAsarPath}`);
    }

    // 先完整生成候选文件，再替换旧 archive 和 sidecar；不会把上一次打包的跨平台 native 留在 unpacked。
    // Windows 上扫描器可能短暂持有旧 archive 句柄，删除/改名必须走同一条退避重试路径。
    retryOnWindowsFileLock(() => rmSync(unpackedPath, { force: true, recursive: true }), "app.asar.unpacked");
    retryOnWindowsFileLock(
      () => renameSync(candidateUnpackedPath, unpackedPath),
      "app.asar.unpacked rename",
    );
    retryOnWindowsFileLock(() => rmSync(appAsarPath, { force: true }), "app.asar");
    retryOnWindowsFileLock(
      () => renameSync(candidateAsarPath, appAsarPath),
      "app.asar rename",
    );
  } finally {
    await Promise.all([
      rm(candidateAsarPath, { force: true, recursive: true }),
      rm(candidateUnpackedPath, { force: true, recursive: true }),
    ]);
  }
}
