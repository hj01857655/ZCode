# 25 · 远程目标（SSH / WSL / Docker / Server）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` `createOpenInEditorRemoteTarget`（`jdr`）与相关 schema

## 1. 四种远程形态

```js
switch (e.kind) {
  case "ssh":    return { kind:"ssh", host, port, username, sshConfigAlias? };   // 别名可引用 ~/.ssh/config
  case "wsl":    return { kind:"wsl", distro, user? };
  case "docker": return { kind:"docker", container };
  case "server": return {};   // 已连接的 ZCode 服务端形态（无本地参数）
}
```

## 2. 凭证剥离

远程目标在序列化/展示前剥离敏感字段（`Vnr` = `stripRemoteTargetSecrets`）：

- ssh：剥离 `password`、`privateKeyPassphrase`
- server：剥离 `token`
- wsl/docker：无敏感字段

## 3. 与其他体系的关系

- 远程目标的进程树管理：`runtime 进程树强制回收`（Windows taskkill 预算、残留 pid 清理、身份验证 `resolveCurrentOwnedIdentities`）——对远端 agent 进程做生命周期治理。
- 远程会话与本地会话同构：`session.workspace_id` / `tasks.workspace_key` 区分工作区，UI 按 workspace 分组。
- 分享/远程控制（[17](zcode-plan-17-云端会话与远程体系.md)）叠加在任一目标形态之上。

## 4. 边界说明

SSH/WSL/Docker 的连接建立细节（端口转发命令、agent 二进制下发）在 host 侧，未逐条还原；本文为 schema 级还原。
