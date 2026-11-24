/**
 * ui-model-provider-section 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiModelProviderSectionModule = {
  id: "ui-model-provider-section",
  requires: ["provider", "services", "shared", "ui"],
  provides: ["ui-model-provider-section"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
