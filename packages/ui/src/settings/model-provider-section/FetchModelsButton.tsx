import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderApiType } from "@zcode/provider";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFetchProviderModelIds } from "@/hooks/useModelProviders.js";

/**
 * 「获取模型列表」按钮：通过 ProviderSettingsService 让 Host 发起远端 /models 请求，
 * 勾选后批量导入为 Personal Model。请求不落在 renderer，避免 preflight/CORS/CSP 拦截。
 */
export function FetchModelsButton({
  apiFormat,
  baseUrl,
  apiKey,
  headers,
  existingModelIds,
  onAddModels,
}: {
  apiFormat: ProviderApiType;
  baseUrl: string;
  apiKey: string;
  /** Provider 配置的自定义请求头；真实模型请求同样会带，拉列表时不能丢。 */
  headers?: Readonly<Record<string, string>>;
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
  const fetchProviderModelIds = useFetchProviderModelIds();
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    // 输入变化后旧请求即使返回也不能写回候选列表；RPC 本身不可取消，用序号丢弃过期结果。
    requestIdRef.current += 1;
    setFetching(false);
    setError(null);
    setCandidates([]);
    setSelected(new Set());
  }, [apiFormat, baseUrl, apiKey]);

  const handleFetch = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setFetching(true);
    setError(null);
    setOpen(true);
    setCandidates([]);
    setSelected(new Set());
    try {
      const ids = await fetchProviderModelIds({
        apiFormat,
        baseUrl,
        apiKey,
        headers,
      });
      if (requestId !== requestIdRef.current) return;
      // 必须读本次渲染的 existingModelIds：导入后父级会传新数组，闭包里不能沿用旧快照，
      // 否则再次拉取会把已导入的模型当成候选重复展示。
      const existing = new Set(existingModelIds);
      const fresh = ids.filter((id) => !existing.has(id));
      setCandidates(fresh);
      setSelected(new Set(fresh));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(/timeout|aborted/i.test(message) ? "timeout" : message);
    } finally {
      if (requestId === requestIdRef.current) setFetching(false);
    }
  }, [apiFormat, baseUrl, apiKey, headers, existingModelIds, fetchProviderModelIds]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setError(null);
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

  const canFetch = Boolean(baseUrl.trim() && apiKey.trim());

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="default"
        className="rounded-lg"
        data-testid="model-provider-fetch-models-button"
        disabled={fetching || !canFetch}
        onClick={() => void handleFetch()}
      >
        {intl.formatMessage({ id: "settings.modelProvider.fetchModels" })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[70vh] max-w-md overflow-hidden"
          aria-describedby={undefined}
        >
          <DialogTitle>
            {intl.formatMessage({
              id: "settings.modelProvider.fetchModels.title",
            })}
          </DialogTitle>
          <div className="max-h-[45vh] space-y-1 overflow-y-auto">
            {fetching ? (
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "settings.modelProvider.fetchModels.loading",
                })}
              </div>
            ) : candidates.length === 0 && !error ? (
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "settings.modelProvider.fetchModels.empty",
                })}
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
            <div
              className="text-ui-sm text-destructive"
              data-testid="model-provider-fetch-models-error"
            >
              {intl.formatMessage({ id: "settings.modelProvider.fetchModels.error" }, { error })}
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
              disabled={importing || fetching || selected.size === 0}
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
