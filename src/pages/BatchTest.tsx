import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Square, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { PageFooter } from "@/components/PageFooter";
import { usePlatformStore } from "@/store/platformStore";
import { toast } from "@/components/Toast";

// ── 类型定义 ──────────────────────────────────────────────
type TestStatus = "waiting" | "running" | "done" | "error" | "stopped";

interface OutputLine {
  type: "text" | "tool";
  content: string;
}

interface PlatformResult {
  platformId: string;
  platformName: string;
  model: string;
  status: TestStatus;
  lines: OutputLine[];
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface BatchOutputPayload {
  run_id: string;
  platform_id: string;
  event_type: string;
  content?: string;
  elapsed_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
}

// ── 将 lines 按类型分组（连续同类型合并），保留顺序 ────────
type LineGroup =
  | { type: "text"; content: string }
  | { type: "tool"; lines: string[] };

function groupLines(lines: OutputLine[]): LineGroup[] {
  const groups: LineGroup[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (line.type === "text") {
      if (last?.type === "text") {
        last.content += line.content;
      } else {
        groups.push({ type: "text", content: line.content });
      }
    } else {
      if (last?.type === "tool") {
        last.lines.push(line.content);
      } else {
        groups.push({ type: "tool", lines: [line.content] });
      }
    }
  }
  return groups;
}

// ── 工具函数 ──────────────────────────────────────────────
function genRunId() {
  const now = new Date();
  const p = (n: number, d = 2) => String(n).padStart(d, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ── 状态徽章 ──────────────────────────────────────────────
function StatusBadge({ status }: { status: TestStatus }) {
  const map: Record<TestStatus, { label: string; cls: string }> = {
    waiting: { label: "等待", cls: "bg-secondary text-muted-foreground" },
    running: { label: "运行中", cls: "bg-blue-500/20 text-blue-400 animate-pulse" },
    done: { label: "完成", cls: "bg-green-500/20 text-green-400" },
    error: { label: "失败", cls: "bg-red-500/20 text-red-400" },
    stopped: { label: "已停止", cls: "bg-yellow-500/20 text-yellow-400" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ── 主页面 ────────────────────────────────────────────────
export default function BatchTest() {
  const { platforms, loadPlatforms } = usePlatformStore();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [saveDir, setSaveDir] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<"realtime" | "compare">("realtime");
  const [results, setResults] = useState<Map<string, PlatformResult>>(new Map());
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  const unlistenRef = useRef<Array<() => void>>([]);
  const outputRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    loadPlatforms();
    invoke<string>("get_batch_save_dir")
      .then((dir) => { if (dir) setSaveDir(dir); })
      .catch(() => {});
  }, [loadPlatforms]);

  // 卸载时清理监听器
  useEffect(() => {
    return () => {
      unlistenRef.current.forEach((fn) => fn());
    };
  }, []);

  const sorted = [...platforms].sort((a, b) => a.order - b.order);

  const togglePlatform = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handlePickDir = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (dir && typeof dir === "string") {
      setSaveDir(dir);
      invoke("set_batch_save_dir", { dir }).catch(() => {});
    }
  };

  const cleanupListeners = useCallback(() => {
    unlistenRef.current.forEach((fn) => fn());
    unlistenRef.current = [];
  }, []);

  const handleStart = async () => {
    if (selectedIds.size === 0) { toast.error("请至少选择一个平台"); return; }
    if (!prompt.trim()) { toast.error("请输入测试提示词"); return; }
    if (!saveDir) { toast.error("请选择保存目录"); return; }

    const runId = genRunId();
    setCurrentRunId(runId);
    setIsRunning(true);
    setActiveTab("realtime");

    // 初始化每个平台的结果状态
    const init = new Map<string, PlatformResult>();
    for (const id of selectedIds) {
      const p = sorted.find((x) => x.id === id);
      if (p) {
        init.set(id, {
          platformId: id,
          platformName: p.name,
          model: p.defaultModel,
          status: "waiting",
          lines: [],
        });
      }
    }
    setResults(init);

    // 注册事件监听器
    cleanupListeners();

    const unlisten1 = await listen<BatchOutputPayload>("batch_output", (ev) => {
      const { run_id, platform_id, event_type, content, elapsed_ms, input_tokens, output_tokens } = ev.payload;
      if (run_id !== runId) return;

      setResults((prev) => {
        const next = new Map(prev);
        const r = next.get(platform_id);
        if (!r) return prev;
        const updated: PlatformResult = { ...r, lines: [...r.lines] };

        switch (event_type) {
          case "start":
            updated.status = "running";
            break;
          case "text":
            if (content) updated.lines.push({ type: "text", content });
            break;
          case "tool":
            if (content) updated.lines.push({ type: "tool", content });
            break;
          case "done":
            updated.status = "done";
            if (elapsed_ms !== undefined) updated.elapsedMs = elapsed_ms;
            if (input_tokens !== undefined) updated.inputTokens = input_tokens;
            if (output_tokens !== undefined) updated.outputTokens = output_tokens;
            break;
          case "error":
            updated.status = "error";
            if (content) updated.lines.push({ type: "text", content: `✗ ${content}` });
            if (elapsed_ms !== undefined) updated.elapsedMs = elapsed_ms;
            if (input_tokens !== undefined) updated.inputTokens = input_tokens;
            if (output_tokens !== undefined) updated.outputTokens = output_tokens;
            break;
          case "stopped":
            updated.status = "stopped";
            if (elapsed_ms !== undefined) updated.elapsedMs = elapsed_ms;
            break;
        }

        next.set(platform_id, updated);
        return next;
      });

      // 自动滚动到底部
      const el = outputRefs.current.get(platform_id);
      if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    });

    const unlisten2 = await listen<{ run_id: string }>("batch_complete", (ev) => {
      if (ev.payload?.run_id !== runId) return;
      setIsRunning(false);
      cleanupListeners();
    });

    unlistenRef.current = [unlisten1, unlisten2];

    try {
      await invoke("start_batch_test", {
        platformIds: Array.from(selectedIds),
        prompt: prompt.trim(),
        saveDir,
        runId,
      });
    } catch (err) {
      toast.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
      setIsRunning(false);
      cleanupListeners();
    }
  };

  const handleStop = async () => {
    if (!currentRunId) return;
    try {
      await invoke("stop_batch_test", { runId: currentRunId });

      // 先移除监听器，再同步更新 UI——
      // 不能依赖后端 "stopped" 事件，因为 kill 后事件可能在监听器清理后才到达
      cleanupListeners();
      setIsRunning(false);

      // 把所有还在 waiting / running 的平台立即标为 stopped
      setResults((prev) => {
        const next = new Map(prev);
        for (const [id, r] of next) {
          if (r.status === "waiting" || r.status === "running") {
            next.set(id, { ...r, status: "stopped" });
          }
        }
        return next;
      });

      toast.success("已停止测试");
    } catch (err) {
      toast.error(`停止失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ── 统计数据 ───────────────────────────────────────────
  const resultsArr = Array.from(results.values());
  const completedCount = resultsArr.filter((r) => r.status === "done").length;
  const totalCount = resultsArr.length;

  const doneTimes = resultsArr
    .filter((r) => r.status === "done" && r.elapsedMs !== undefined)
    .map((r) => r.elapsedMs!);
  const fastestMs = doneTimes.length > 0 ? Math.min(...doneTimes) : undefined;

  const doneTokens = resultsArr
    .filter((r) => r.outputTokens !== undefined)
    .map((r) => r.outputTokens!);
  const avgTokens =
    doneTokens.length > 0
      ? Math.round(doneTokens.reduce((s, t) => s + t, 0) / doneTokens.length)
      : undefined;

  const savePath = currentRunId ? `${saveDir}/${currentRunId}` : "—";

  // ── 渲染 ──────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">

          {/* 平台选择 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">平台选择</span>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <button
                  onClick={() => setSelectedIds(new Set(sorted.map((p) => p.id)))}
                  className="hover:text-foreground transition-colors"
                >
                  全选
                </button>
                <span>·</span>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="hover:text-foreground transition-colors"
                >
                  清除
                </button>
              </div>
            </div>
            {sorted.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                暂无平台配置，请先在主页添加
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {sorted.map((p) => {
                  const selected = selectedIds.has(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePlatform(p.id)}
                      disabled={isRunning}
                      className={`
                        flex items-start gap-2 px-2.5 py-2 rounded-lg border text-left transition-all
                        disabled:opacity-60 disabled:cursor-not-allowed
                        ${selected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-muted-foreground/50 hover:bg-secondary/40"
                        }
                      `}
                    >
                      <span
                        className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                          selected ? "bg-primary" : "bg-muted-foreground/30"
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{p.name}</div>
                        {p.defaultModel && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {p.defaultModel}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 提示词 */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block mb-2">
              测试提示词
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入测试提示词，例如：帮我写一个快速排序的 Python 实现并分析时间复杂度"
              rows={4}
              disabled={isRunning}
              className="w-full px-3 py-2 text-sm rounded-lg border bg-background resize-none
                         focus:outline-none focus:ring-1 focus:ring-primary
                         disabled:opacity-60 disabled:cursor-not-allowed
                         placeholder:text-muted-foreground/50"
            />
          </div>

          {/* 保存目录 + 按钮行 */}
          <div className="flex items-center gap-2">
            <button
              onClick={handlePickDir}
              disabled={isRunning}
              className={`
                flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors
                disabled:opacity-50 disabled:cursor-not-allowed
                ${saveDir
                  ? "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/60"
                  : "border-dashed border-muted-foreground/40 text-muted-foreground/60 hover:border-muted-foreground/70 hover:text-muted-foreground"
                }
              `}
            >
              <FolderOpen className="w-3.5 h-3.5 shrink-0" />
              <span className="max-w-[160px] truncate">
                {saveDir || "选择保存目录"}
              </span>
            </button>
          </div>
        </div>

        {/* 结果区域 */}
        {results.size > 0 && (
          <>
            {/* 统计栏 */}
            <div className="px-4 pb-3">
              <div className="grid grid-cols-4 gap-0 rounded-lg border overflow-hidden bg-secondary/30">
                <div className="px-3 py-2.5 border-r">
                  <div className="text-[10px] text-muted-foreground mb-0.5">已完成</div>
                  <div className="text-sm font-semibold">
                    {completedCount}
                    <span className="text-muted-foreground font-normal text-xs">/{totalCount}</span>
                  </div>
                </div>
                <div className="px-3 py-2.5 border-r">
                  <div className="text-[10px] text-muted-foreground mb-0.5">最快响应</div>
                  <div className="text-sm font-semibold">{formatMs(fastestMs)}</div>
                </div>
                <div className="px-3 py-2.5 border-r">
                  <div className="text-[10px] text-muted-foreground mb-0.5">平均 Token</div>
                  <div className="text-sm font-semibold">{avgTokens ?? "—"}</div>
                </div>
                <div className="px-3 py-2.5 min-w-0">
                  <div className="text-[10px] text-muted-foreground mb-0.5">保存路径</div>
                  <div className="text-[10px] font-mono text-muted-foreground truncate" title={savePath}>
                    {savePath}
                  </div>
                </div>
              </div>
            </div>

            {/* 标签页 */}
            <div className="px-4 border-b">
              <div className="flex gap-4">
                {(["realtime", "compare"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`text-sm pb-2 border-b-2 transition-colors ${
                      activeTab === tab
                        ? "border-primary text-foreground font-medium"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab === "realtime" ? "实时输出" : "对比视图"}
                  </button>
                ))}
              </div>
            </div>

            {/* 标签内容 */}
            <div className="p-4">
              {activeTab === "realtime" ? (
                <div className="space-y-3">
                  {resultsArr.map((r) => (
                    <div key={r.platformId} className="border rounded-lg overflow-hidden">
                      {/* 平台标题行 */}
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary/40 border-b">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-xs">{r.platformName}</span>
                          {r.model && (
                            <span className="text-[10px] text-muted-foreground font-mono truncate">
                              {r.model}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          {r.elapsedMs !== undefined && (
                            <span className="text-[10px] text-muted-foreground">
                              {formatMs(r.elapsedMs)}
                            </span>
                          )}
                          <StatusBadge status={r.status} />
                        </div>
                      </div>
                      {/* 输出内容 */}
                      <div
                        ref={(el) => {
                          if (el) outputRefs.current.set(r.platformId, el);
                        }}
                        className="batch-output p-3 h-56 text-[12px] leading-relaxed"
                      >
                        {r.lines.length === 0 ? (
                          <span className="text-muted-foreground/50 font-mono text-[11px]">
                            {r.status === "waiting" ? "等待中..." : "运行中..."}
                          </span>
                        ) : (
                          groupLines(r.lines).map((group, i) =>
                            group.type === "tool" ? (
                              <div key={i} className="my-1">
                                {group.lines.map((l, j) => (
                                  <div key={j} className="font-mono text-[11px] text-blue-400/80 py-0.5">
                                    {l}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div
                                key={i}
                                className="
                                  prose prose-sm dark:prose-invert max-w-none
                                  [&_h1]:text-sm [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-1
                                  [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1
                                  [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5
                                  [&_p]:my-1 [&_p]:text-foreground/90
                                  [&_ul]:my-1 [&_ul]:ml-4 [&_ul]:list-disc
                                  [&_ol]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal
                                  [&_li]:my-0.5
                                  [&_code]:font-mono [&_code]:text-[11px] [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
                                  [&_pre]:my-1.5 [&_pre]:bg-secondary [&_pre]:rounded-md [&_pre]:p-2.5 [&_pre]:overflow-x-auto
                                  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11px]
                                  [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:my-1
                                  [&_strong]:font-semibold
                                  [&_a]:text-primary [&_a]:underline
                                  [&_hr]:border-border [&_hr]:my-2
                                "
                              >
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {group.content}
                                </ReactMarkdown>
                              </div>
                            )
                          )
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left pb-2 font-medium">平台</th>
                      <th className="text-left pb-2 font-medium">模型</th>
                      <th className="text-right pb-2 font-medium">响应时间</th>
                      <th className="text-right pb-2 font-medium">Token 用量</th>
                      <th className="text-right pb-2 font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultsArr.map((r) => (
                      <tr key={r.platformId} className="border-b last:border-0">
                        <td className="py-2.5 font-medium">{r.platformName}</td>
                        <td className="py-2.5 font-mono text-muted-foreground truncate max-w-[80px]">
                          {r.model || "—"}
                        </td>
                        <td className="py-2.5 text-right text-muted-foreground">
                          {formatMs(r.elapsedMs)}
                        </td>
                        <td className="py-2.5 text-right text-muted-foreground">
                          {r.inputTokens !== undefined
                            ? `${r.inputTokens}↑ ${r.outputTokens ?? 0}↓`
                            : "—"}
                        </td>
                        <td className="py-2.5 text-right">
                          <StatusBadge status={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <PageFooter>
        <div className="ml-auto">
          {isRunning ? (
            <Button variant="destructive" size="sm" onClick={handleStop}>
              <Square className="w-3 h-3 mr-1.5" fill="currentColor" />
              停止测试
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleStart}
              disabled={selectedIds.size === 0 || !prompt.trim() || !saveDir}
            >
              <Play className="w-3 h-3 mr-1.5" fill="currentColor" />
              运行批量测试
            </Button>
          )}
        </div>
      </PageFooter>
    </div>
  );
}
