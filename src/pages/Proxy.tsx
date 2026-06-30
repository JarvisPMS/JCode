import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Play,
  Square,
  Trash2,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageFooter } from "@/components/PageFooter";
import { useProxyStore } from "@/store/proxyStore";
import { usePlatformStore } from "@/store/platformStore";
import { DEFAULT_CLAUDE_ID } from "@/lib/presets";
import { toast } from "@/components/Toast";
import type { ProxyMapping } from "@/types/proxy";

export default function Proxy() {
  const { config, status, loading, load, save, start, stop } = useProxyStore();
  const { platforms, loadPlatforms } = usePlatformStore();
  const [port, setPort] = useState(8765);
  const [mappings, setMappings] = useState<ProxyMapping[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    load();
    loadPlatforms();
  }, [load, loadPlatforms]);

  useEffect(() => {
    setPort(config.port);
    setMappings(config.mappings);
  }, [config]);

  const dirty = useMemo(() => {
    return (
      port !== config.port ||
      JSON.stringify(mappings) !== JSON.stringify(config.mappings)
    );
  }, [port, mappings, config]);

  // 排除默认 Claude 卡片（授权登录、无 API Key，不能作为代理目标）
  const sortedPlatforms = useMemo(
    () =>
      [...platforms]
        .filter((p) => p.id !== DEFAULT_CLAUDE_ID)
        .sort((a, b) => a.order - b.order),
    [platforms]
  );

  const platformById = useMemo(() => {
    const m = new Map<string, (typeof platforms)[number]>();
    for (const p of platforms) m.set(p.id, p);
    return m;
  }, [platforms]);

  const updateMapping = (id: string, patch: Partial<ProxyMapping>) => {
    setMappings((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  };

  const addMapping = () => {
    setMappings((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        sourceModel: "",
        targetPlatformId: "",
        targetModel: "",
      },
    ]);
  };

  const removeMapping = (id: string) => {
    setMappings((prev) => prev.filter((m) => m.id !== id));
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      // 校验
      const seen = new Set<string>();
      for (const m of mappings) {
        const src = m.sourceModel.trim();
        if (!src) {
          toast.error("存在未填写的源模型名");
          setBusy(false);
          return;
        }
        if (seen.has(src)) {
          toast.error(`源模型名重复：${src}`);
          setBusy(false);
          return;
        }
        seen.add(src);
      }
      await save({ port, mappings });
      toast.success("已保存");
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    setBusy(false);
  };

  const handleToggle = async () => {
    setBusy(true);
    try {
      if (status.running) {
        await stop();
        toast.success("代理已停止");
      } else {
        if (dirty) {
          await save({ port, mappings });
        }
        await start();
        toast.success(`代理已启动：http://127.0.0.1:${port}`);
      }
    } catch (err) {
      toast.error(
        `${status.running ? "停止" : "启动"}失败: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    setBusy(false);
  };

  const baseUrl = status.running
    ? `http://127.0.0.1:${status.port ?? port}`
    : `http://127.0.0.1:${port}`;

  const copyBaseUrl = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground text-sm">加载中...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="p-6 space-y-6 max-w-3xl mx-auto">
        {/* 映射规则 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">模型名映射</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleSave}
                disabled={busy || !dirty}
              >
                保存
              </Button>
              <Button size="sm" variant="outline" onClick={addMapping}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                新增
              </Button>
            </div>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_1fr_1fr_auto] gap-2 px-3 py-2 text-xs text-muted-foreground bg-secondary/40 border-b">
              <div>源模型名</div>
              <div className="w-4"></div>
              <div>目标平台</div>
              <div>目标模型</div>
              <div className="w-7"></div>
            </div>

            {mappings.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                还没有映射规则，点击右上角「新增」添加
              </div>
            ) : (
              mappings.map((m) => {
                const platform = platformById.get(m.targetPlatformId);
                const modelOptions = platform
                  ? (platform.models || "")
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [];
                return (
                  <div
                    key={m.id}
                    className="grid grid-cols-[1fr_auto_1fr_1fr_auto] gap-2 px-3 py-2 items-center border-b last:border-b-0"
                  >
                    <Input
                      value={m.sourceModel}
                      onChange={(e) =>
                        updateMapping(m.id, { sourceModel: e.target.value })
                      }
                      placeholder="claude-sonnet-4-7"
                      className="h-8 text-xs"
                    />
                    <span className="text-muted-foreground text-xs select-none">
                      →
                    </span>
                    <select
                      value={m.targetPlatformId}
                      onChange={(e) =>
                        updateMapping(m.id, {
                          targetPlatformId: e.target.value,
                          targetModel: "",
                        })
                      }
                      className="h-8 text-xs rounded-md border border-input bg-background px-2"
                    >
                      <option value="">选择平台</option>
                      {sortedPlatforms.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {modelOptions.length > 0 ? (
                      <select
                        value={m.targetModel}
                        onChange={(e) =>
                          updateMapping(m.id, { targetModel: e.target.value })
                        }
                        className="h-8 text-xs rounded-md border border-input bg-background px-2"
                      >
                        <option value="">选择模型</option>
                        {modelOptions.map((mn) => (
                          <option key={mn} value={mn}>
                            {mn}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        value={m.targetModel}
                        onChange={(e) =>
                          updateMapping(m.id, { targetModel: e.target.value })
                        }
                        placeholder={
                          m.targetPlatformId
                            ? "该平台未配置模型，手动填写"
                            : "先选择平台"
                        }
                        disabled={!m.targetPlatformId}
                        className="h-8 text-xs"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeMapping(m.id)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

        </div>

        {/* 说明 */}
        <ul className="border-t pt-5 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
          <li>
            ① 客户端 baseUrl 改为
            <code className="mx-1 px-1 rounded bg-secondary text-foreground font-mono">
              {baseUrl}
            </code>
          </li>
          <li>
            ② 客户端 API Key 设置为
            <code className="mx-1 px-1 rounded bg-secondary text-foreground font-mono">
              jcodenb
            </code>
          </li>
          <li>③ 客户端发送的模型名按上表替换后透传到目标平台（SSE 原样转发）</li>
          <li>④ 目标平台需支持 Anthropic Messages API</li>
        </ul>
      </div>

      <PageFooter>
        <div className="ml-auto flex items-center gap-2">
          <Input
            id="port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 0)}
            disabled={status.running}
            className="w-20 h-9 text-center"
            title="监听端口"
          />
          <Button
            size="sm"
            variant={status.running ? "destructive" : "default"}
            onClick={handleToggle}
            disabled={busy || port < 1 || port > 65535}
          >
            {status.running ? (
              <>
                <Square className="w-3.5 h-3.5 mr-1.5" />
                停止
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 mr-1.5" />
                启动
              </>
            )}
          </Button>
          {status.running && (
            <button
              type="button"
              onClick={copyBaseUrl}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md border bg-background hover:bg-secondary text-muted-foreground hover:text-foreground"
              title="复制 baseUrl"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </PageFooter>
    </div>
  );
}
