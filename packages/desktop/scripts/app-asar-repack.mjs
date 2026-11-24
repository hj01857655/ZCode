import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, rmSync, renameSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { access, rm } from "node:fs/promises";

export const ASAR_UNPACK_NATIVE_GLOB = "*.{node,dll,dylib,exe}";

const ASAR_REPLACE_RETRY_COUNT = 30;
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

// Windows 文件允许被读写共享打开但不能删除/改名（句柄未开 FILE_SHARE_DELETE）。
// 覆盖写入不会改变目录项，绕开这类锁；必须在候选文件完整生成后调用。
async function overwriteFileContents(sourcePath, destinationPath) {
  await pipeline(createReadStream(sourcePath), createWriteStream(destinationPath));
  if (statSync(sourcePath).size !== statSync(destinationPath).size) {
    throw new Error(`覆盖写入后大小不一致: ${sourcePath} -> ${destinationPath}`);
  }
}

function replaceFileFromCandidate({ sourcePath, destinationPath, label }) {
  try {
    retryOnWindowsFileLock(() => renameSync(sourcePath, destinationPath), `${label} rename`);
    return;
  } catch (error) {
    const locked =
      error &&
      (error.code === "EBUSY" ||
        error.code === "EPERM" ||
        /EBUSY|EPERM|resource busy or locked|permission denied/i.test(String(error.message)));
    if (!locked || !statSync(destinationPath, { throwIfNoEntry: false })) throw error;
  }
  // 目标仍存在且不可替换时，直接覆盖内容；unpacked 是目录，只能走 rename。
  retryOnWindowsFileLock(
    () => overwriteFileContents(sourcePath, destinationPath),
    `${label} overwrite`,
  );
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
    // Windows 扫描器可能持有句柄导致删除/改名 EPERM；先退避重试，仍失败时 app.asar 走覆盖写入。
    retryOnWindowsFileLock(() => rmSync(unpackedPath, { force: true, recursive: true }), "app.asar.unpacked");
    retryOnWindowsFileLock(
      () => renameSync(candidateUnpackedPath, unpackedPath),
      "app.asar.unpacked rename",
    );
    replaceFileFromCandidate({
      sourcePath: candidateAsarPath,
      destinationPath: appAsarPath,
      label: "app.asar",
    });
  } finally {
    await Promise.all([
      rm(candidateAsarPath, { force: true, recursive: true }),
      rm(candidateUnpackedPath, { force: true, recursive: true }),
    ]);
  }
}
