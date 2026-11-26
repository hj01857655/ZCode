// socket 路径策略直接用官方实现：Windows 固定命名管道前缀
// `\\.\pipe\zcode-cua-helper-<hex|default>`（Helper 会拒绝该命名空间之外的管道），
// 其它平台在用户私有运行目录下生成随机 socket 并清理 24h 前的陈旧文件。
export {
  BROKER_SOCKET_ENV,
  IN_PROCESS_BROKER_SOCKET,
  mintBrokerSocketPath,
  resolveBrokerSocketPath,
} from "./vendor/official-runtime.js";