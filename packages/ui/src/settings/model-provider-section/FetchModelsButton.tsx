import { useCallback, useState } from "react";
import type { ProviderApiType } from "@zcode/provider";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 从 OpenAI 兼容端点或 Anthropic Messages 端点拉取模型列表。
 *
 * 两种 OpenAI 协议共用 GET {baseUrl}/models；Anthropic 是 GET {baseUrl}/v1/models，
 * 鉴权头为 x-api-key + anthropic-version。响应统一按 { data: [{ id }] } 解析，
 * 非 OpenAI 兼容的响应体（没有 data[].id）按失败处理，回退手填。
 */
export async function fetchProviderModelIds(params: {
  apiFormat: ProviderApiType;
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const { apiFormat, baseUrl, apiKey } = params;
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("empty-base-url");

  let url: string;
  const headers: Record<string, string> = {};
  if (apiFormat === "anthropic-messages") {
    url = `${base}/v1/models`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    // openai-chat-completions / openai-responses：baseUrl 通常已含 /v1；未含则补。
    const withV1 = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    url = `${withV1}/models`;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`http-${response.status}`);
  }
  const body: unknown = await response.json();
  const ids = extractModelIds(body);
  if (!ids) throw new Error("unexpected-response");
  return ids;
}

function extractModelIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    const id =
      typeof entry === "object" && entry !== null
        ? (entry as { id?: unknown }).id
        : undefined;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * 「获取模型列表」按钮：拉取远端 /models，勾选后批量导入为 Personal Model。
 * 导入走现有 addModel 链路，personalConfig 留空并保持智能配置，由推荐配置兜底。
 */
export function FetchModelsButton({
  apiFormat,
  baseUrl,
  apiKey,
  existingModelIds,
  onAddModels,
}: {
  apiFormat: ProviderApiType;
  baseUrl: string;
  apiKey: string;
  existingModelIds: readonly string[];
  onAddModels: (modelIds: string[]) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const existing = new Set(existingModelIds);

  const handleFetch = useCallback(async () => {
    setFetching(true);
    setError(null);
    try {
      const ids = await fetchProviderModelIds({ apiFormat, baseUrl, apiKey });
      const fresh = ids.filter((id) => !existing.has(id));
      setCandidates(fresh);
      setSelected(new Set(fresh));
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
    // existing 是渲染期快照，拉取一次即走，不需要进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFormat, baseUrl, apiKey]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      await onAddModels([...selected]);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [onAddModels, selected]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="default"
        className="rounded-lg"
        data-testid="model-provider-fetch-models-button"
        disabled={fetching || !baseUrl.trim()}
        onClick={() => void handleFetch()}
      >
        {intl.formatMessage({ id: "settings.modelProvider.fetchModels" })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[70vh] max-w-md overflow-hidden">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.fetchModels.title" })}
          </DialogTitle>
          <div className="max-h-[45vh] space-y-1 overflow-y-auto">
            {candidates.length === 0 ? (
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProvider.fetchModels.empty" })}
              </div>
            ) : (
              candidates.map((id) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-ui-base hover:bg-input"
                >
                  <Checkbox
                    checked={selected.has(id)}
                    onCheckedChange={() => toggle(id)}
                    data-testid={`model-provider-fetch-model-item-${id}`}
                  />
                  <span className="min-w-0 break-all">{id}</span>
                </label>
              ))
            )}
          </div>
          {error ? (
            <div className="text-ui-sm text-destructive">
              {intl.formatMessage(
                { id: "settings.modelProvider.fetchModels.error" },
                { error },
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={importing}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              onClick={() => void handleImport()}
              disabled={importing || selected.size === 0}
              data-testid="model-provider-fetch-models-import"
            >
              {intl.formatMessage(
                { id: "settings.modelProvider.fetchModels.import" },
                { count: selected.size },
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
