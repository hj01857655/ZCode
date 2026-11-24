/**
 * ui-model-provider-section 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
export type UiModelProviderSectionId = string & { readonly __brand: "UiModelProviderSectionId" };

export interface UiModelProviderSectionContract {
  // 本模块以 React 组件形态供 ModelProviderSection.tsx 装配，不导出运行时服务：
  // Detail / SectionLayout / InlineEditableProviderCard / ProviderCardSections 及其子组件。
}
