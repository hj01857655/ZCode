// request_access 状态块的 _meta 键与 zod 校验取发行包 dist/request-access-contract。
// producer 包已声明 zod 依赖，这里不再手写等价 schema。
export {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "./vendor/official-runtime.js";