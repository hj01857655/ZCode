# 40 · 反馈日志打包与上传

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：`resources\app.asar` 内 `out/main/index.js`（`@zcode/desktop` **3.14.3**，735,396 B）符号追踪
> 交叉：[38 §3](zcode-plan-38-外部报告交叉核对.md)（外部报告提到 `/feedback/attachment/upload-credential`）

## 0. 结论

**「导出日志」与「反馈工单」是两条不同的打包路径，共用同一套底层函数。** 后者会把 `~/.zcode/v2` 整个目录、CLI 全部聊天记录、sqlite 状态库一并打包上传。

3.14.3 里已存在一条**最小化的**日志源列表（`createFeedbackLogArchiveFromExportLogs`），但**反馈工单走的那条仍然全量收集**。

---

## 1. 两条路径

| 函数 | 用途 | 收集范围 |
|---|---|---|
| `createLogArchiveArtifacts` (`g0`) | **反馈工单** | **全量**（见 §2） |
| `createFeedbackLogArchiveFromExportLogs` (`Sv`) | 导出日志 | 已最小化 |

```js
// createFeedbackLogArchiveFromExportLogs —— 已是干净的三源列表
sources: [
  { directory: qe(e,"logs"),   archivePrefix: "logs" },
  { directory: hv(),          archivePrefix: ".zcode/cli/log" },
  { directory: wv(),          archivePrefix: ".zcode/computer-use/run", exitLogsOnly: true }
]
```

**只有反馈工单那条需要处理。**

---

## 2. `createLogArchiveArtifacts` 实际收集什么

```js
async function g0(e, t = {}) {            // createLogArchiveArtifacts   @431334
  let r = [], o = new Set;
  await Ki(e, "", o, r);                                  // ← 整个 ~/.zcode/v2，递归
  let n = hv();
  await Ki(n, Eo.join(".zcode","cli","log"), o, r);
  let i = gv();
  await bv(qe(i,"config.json"),
           Eo.join(".zcode","cli","config.json"), r),    // ← CLI 配置
  await Ki(qe(i,"rollout"),
           Eo.join(".zcode","cli","rollout"), o, r),    // ← 全部聊天记录
  await m0(wv(),
           Eo.join(".zcode","computer-use","run"), vL, r);
  let a = await l0(r, t);
  return a.sort((c,d) => c.archivePath.localeCompare(d.archivePath)),
         { files: a, aboutContent: u0() }                // ← 附 about.txt
}
```

**进包内容清单：**

| 路径 | 内容 |
|---|---|
| `~/.zcode/v2/`（整目录递归） | `agents-state` / `bot-state` / `coding-plan-cache` / `tasks-index.sqlite` / `crash` / 设置等 |
| `~/.zcode/cli/config.json` | CLI 配置 |
| `~/.zcode/cli/rollout/` | **全部聊天记录** |
| `~/.zcode/cli/log/` | CLI 日志 |
| `~/.zcode/computer-use/run` | computer-use 运行日志 |
| `about.txt` | 版本与环境信息（由 `writeLogArchiveDirectory` 写入） |

**无 mtime 过滤**——`t` 直接透传给 `l0`，渲染端按 full 模式收集。

### 2.1 调用方

```js
async function Zi(e = {}) {            // @433459
  let o = e.createLogArchiveArtifacts ?? g0,
      n = e.writeLogArchiveZip         ?? y0,
      i = e.writeLogArchiveDirectory   ?? vv;
  …
  let v = await o(l, { now: t });
  await n(P, v, { stageRootDir: c() });
}
```

默认注入 `g0` / `y0` / `vv` 三个函数——**依赖注入形态，可整体替换**。

---

## 3. 外部补丁（log_guard）在本机的可用性

外部脚本 `zcode_3.9.1_log_guard.py` 针对 **3.9.1**，做两处等长字节替换：

1. `createLogArchiveArtifacts` 只收近两天日志（`zLogGuard = 2`），不再收 `config.json` / `rollout` / v2 状态 / computer-use
2. `writeLogArchiveDirectory` 不再写 `about.txt`

### 3.1 核对结果（2026-09-27）

```
out/main/index.js  735,396 字节
锚点 hK createLogArchiveArtifacts : 0   ✗ 版本不符
锚点 wK writeLogArchiveDirectory  : 0   ✗ 版本不符
函数名 createLogArchiveArtifacts  : 存在（2 次）
函数名 writeLogArchiveDirectory   : 存在（2 次）
```

**补丁会拒绝执行**（要求锚点各恰好 1）。**但只是压缩符号改名，结构逐字一致。**

### 3.2 符号映射（3.9.1 → 3.14.3）

| `createLogArchiveArtifacts` | 3.9.1 | 3.14.3 |
|---|---|---|
| 函数本身 | `hK` | `g0` |
| 递归收集 | `Oh` | `Ki` |
| cli/log 目录 | `fge` | `hv` |
| path join | `Pa` | `Eo` |
| 根目录 | `pK` | `gv` |
| 单文件加入 | `gK` | `bv` |
| 子路径拼接 | `Ut` | `qe` |
| computer-use | `ahe` / `gge` | `m0` / `vL` |
| 汇总 | `ohe` | `l0` |
| about 内容 | `ihe` | `u0` |

| `writeLogArchiveDirectory` | 3.9.1 | 3.14.3 |
|---|---|---|
| 函数本身 | `wK` | `vv` |
| 建目录 | `kl` | `qi` |
| 复制 | `dhe` | `h0` |
| 记日志 | `lhe` | `w0` |
| 写 about.txt | `cge` | `gL` |

**重新锚定只需替换这张表**，逻辑无需改动。

### 3.3 Electron fuse（本机实测）

```
ZCode.exe  fuse 数 9，fuse[4] = '0' 已禁用
✓ EnableEmbeddedAsarIntegrityValidation 未启用 —— 等长字节替换不破坏 asar 完整性
```

sentinel = `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`，格式 = sentinel + 1B 版本 + 1B 数量 + ASCII `'0'/'1'`，**下标 4 即目标 fuse**。

**结论：阻碍是版本，不是 fuse。** 用 3.14.3 的符号重建锚点后，技术上可打。

---

## 4. 证据分级

| 结论 | 级别 |
|---|---|
| 反馈工单打包全量收集 v2 / config.json / rollout / computer-use | **A 实测**（3.14.3 反编译） |
| 导出日志路径已最小化 | **A 实测** |
| `createLogArchiveArtifacts` 可通过依赖注入整体替换 | **A 实测** |
| 3.9.1 补丁的符号映射表 | **A 实测**（逐符号对照） |
| 本机 fuse 未启用，等长替换安全 | **A 实测** |
| 上传端点 `/feedback/attachment/upload-credential` 的实际请求 | **未验证**（仅有外部报告提及，未抓包） |

## 5. 工具

```powershell
node _re\check_log_guard.js     # 锚点匹配数 + fuse 状态 + 打印本机实现
node _re\asar_pick.js root       # 桌面端版本
node _re\asar_pick.js get out/main/index.js _main.js
```
