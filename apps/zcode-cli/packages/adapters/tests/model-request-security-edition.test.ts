import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryProviderConfig } from "@zcode/provider";
import { createModelRequestSecurityState } from "../src/model/request-security-edition/index.js";

type Access = RegistryProviderConfig["access"];

const rawTransport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

async function callProtect(input: {
  access: Access;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
}) {
  const state = createModelRequestSecurityState();
  const execution = state.createExecution({});
  const wrapped = execution.protectTransport({
    providerId: "test-provider",
    providerConfig: {
      access: input.access,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      headers: input.headers,
    },
    transport: rawTransport,
  });
  return { execution, wrapped, observations: execution.take("request-1") };
}

const apiKeyAccess = (type: "api-key" | "zhipu-coding-plan-api-key"): Access =>
  ({ type, apiKey: "test-key" }) as Access;
const accountAccess = (mode: "start-plan" | "off-peak" | "highspeed" | "individual-coding-plan" | "team-coding-plan"): Access =>
  ({ type: "zhipu-account", accountType: "zai", mode, entitled: true }) as Access;

describe("request-security-edition signing gate", () => {
  beforeEach(() => {
    rawTransport.mockClear();
  });

  it.each([
    ["https://zcode.z.ai", apiKeyAccess("api-key")],
    ["https://api.z.ai/api/coding/v1", apiKeyAccess("api-key")],
    ["https://open.bigmodel.cn/api/anthropic/v1/messages", apiKeyAccess("api-key")],
    ["https://api.chatglm.site", apiKeyAccess("api-key")],
    ["https://zcode.chatglm.site", apiKeyAccess("api-key")],
    ["https://custom.example.test", apiKeyAccess("zhipu-coding-plan-api-key")],
    ["https://custom.example.test", accountAccess("individual-coding-plan")],
    ["https://custom.example.test", accountAccess("team-coding-plan")],
  ] as const)("wraps transport with signing for %s + %s", async (baseURL, access) => {
    const { wrapped } = await callProtect({ access, baseURL, apiKey: "test-key" });
    expect(wrapped).not.toBe(rawTransport);
  });

  it.each([
    ["https://api.example.test", apiKeyAccess("api-key")],
    ["https://z.ai.example.test", apiKeyAccess("api-key")],
    ["https://api.chatglm.site.evil.test", apiKeyAccess("api-key")],
  ] as const)("passes transport through for %s + %s", async (baseURL, access) => {
    const { wrapped, observations } = await callProtect({ access, baseURL, apiKey: "test-key" });
    expect(wrapped).toBe(rawTransport);
    expect(observations).toEqual([]);
  });

  it.each(["start-plan", "off-peak", "highspeed"] as const)(
    "records unsigned access-mode observation on %s without changing the request",
    async (mode) => {
      const { wrapped, execution } = await callProtect({
        access: accountAccess(mode),
        baseURL: "https://api.z.ai/api/anthropic/v1/messages",
        apiKey: "test-key",
      });
      expect(wrapped).not.toBe(rawTransport);

      await wrapped("https://api.z.ai/api/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-request-id": "request-1" },
      });
      expect(rawTransport).toHaveBeenCalledOnce();
      expect(execution.take("request-1")).toEqual([
        { kind: "unsigned_sent", reason: "access_mode" },
      ]);
      expect(execution.take("request-1")).toEqual([]);
    },
  );

  it("does not record access-mode observations outside z.ai/bigmodel root domains", async () => {
    const { wrapped, execution } = await callProtect({
      access: accountAccess("start-plan"),
      baseURL: "https://custom.example.test",
      apiKey: "test-key",
    });
    expect(wrapped).toBe(rawTransport);
    await wrapped("https://custom.example.test/v1/messages", {
      headers: { "x-request-id": "request-1" },
    });
    expect(execution.take("request-1")).toEqual([]);
  });
});
