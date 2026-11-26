import { describe, expect, it } from "vitest";
import { shouldRunCuaScreenCaptureProbe } from "../broker-ports.js";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "../request-access-contract.js";

const validStatus = {
  schemaVersion: 1,
  platform: "darwin",
  grantOwner: "ZCode Computer Use",
  accessibility: "granted",
  screenRecording: "unknown",
} as const;

describe("request_access 状态契约", () => {
  it("接受与 shared schema 一致的 darwin 状态", () => {
    const parsed = cuaRequestAccessStatusSchema.safeParse(validStatus);
    expect(parsed).toEqual({ success: true, data: validStatus });
    expect(CUA_REQUEST_ACCESS_STATUS_META_KEY).toBe("zcode.cua/request-access-status-v1");
  });

  it("拒绝非 darwin、未知枚举与多余字段（strict）", () => {
    for (const broken of [
      { ...validStatus, platform: "win32" },
      { ...validStatus, schemaVersion: 2 },
      { ...validStatus, accessibility: "ok" },
      { ...validStatus, screenRecording: "partial" },
      { ...validStatus, extra: true },
      { ...validStatus, grantOwner: "" },
    ]) {
      expect(cuaRequestAccessStatusSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe("截图功能探针触发条件", () => {
  it("只读刷新一律不抓屏", () => {
    expect(shouldRunCuaScreenCaptureProbe("granted")).toBe(false);
    expect(shouldRunCuaScreenCaptureProbe("granted", {})).toBe(false);
    expect(shouldRunCuaScreenCaptureProbe("granted", { includeFunctionalProbes: false })).toBe(false);
  });

  it("只有显式探针且已授权时才执行", () => {
    expect(shouldRunCuaScreenCaptureProbe("granted", { includeFunctionalProbes: true })).toBe(true);
    expect(shouldRunCuaScreenCaptureProbe("denied", { includeFunctionalProbes: true })).toBe(false);
    expect(shouldRunCuaScreenCaptureProbe(undefined, { includeFunctionalProbes: true })).toBe(false);
  });
});