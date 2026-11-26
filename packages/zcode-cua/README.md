# @zcode/zcode-cua

Computer Use producer package.

## 实现来源

运行时、Broker 协议与 Windows Helper 全部来自 ZCode 4.0.0 发行包内的 `@zcode/zcode-cua`
编译产物，本包只做转发与薄封装，不再维护平行实现：

- `vendor/official-runtime.js`：从发行包 `node-repl-host/dist/mcp/server.js` 切出的
  `@generated` 模块，由 `scripts/extract-official-runtime.mjs` 重新生成；升级客户端后重跑
  该脚本即可对齐。
- `index.js`：转发官方 `createComputerUseRuntime`（14 个工具的参数解析、帧绑定、
  动作策略、会话与 kill switch 都在其中）。
- `broker*.js`：Broker 协议常量、错误分类、管道命名、请求/响应编解码直接重导出官方符号；
  只补发行包未导出的 `callBrokerMethod`（单次 RPC）、`probeHelperHealth`（spawn 后轮询探测）
  与 `handleRequestLine`（用官方 parse/dispatch/serialize 原语拼出）。
- `frame-contract.js`：官方 4 个帧契约符号原样导出；栅格尺寸解码、attestation、
  拒绝脱敏与 preserve 是本包在官方契约之上的扩展。
- `pip-session*.js`：PiP 展示端客户端按官方协议（protocolVersion=2、
  `role:"presentation"` 鉴权、`version_mismatch` 永久禁用）实现。

## Windows Helper

`runtime-manifest.json` 声明 `entry`（`dist/windows-helper.js`）与
`addon`（`build/Release/ax_native.node`），两者均为官方产物，`sha256` 与官方发行包一致。
`package.json#zcodeCuaRuntime` 把同一份声明暴露给打包链：

- 打包暂存只复制 entry 与 addon（`packages/desktop/scripts/windows-cua-helper-assets.mjs`），
  因此 entry 必须自包含；`zcodeCuaHelperRuntimeDependencies` 声明 Helper 运行时需要的
  第三方包（`express`、`sharp`），由打包脚本收集闭包。
- addon 是预编译产物，仓库不再提供 `rebuild:native`：缺失时应从官方发行包重新提取，
  而不是在仓库内另建一份 native 实现。
- Helper 的命名管道只接受 `zcode-cua-helper-` 命名空间
  （`mintBrokerSocketPath` / `resolveBrokerSocketPath`）。

## 测试

```bash
npx vitest run          # 包目录内
```

覆盖：official runtime 的失败边界（未知工具、subagent 作用域、kill switch、
broker 不可达）、进程内 broker 冒烟（需要 `build/Release/ax_native.node`）、
Helper 控制面（用 manifest 声明的 entry 实跑）、帧契约与 broker 契约。

License: Apache-2.0.