import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { usePlatformStore } from "@/store/platformStore";
import { useStatsStore } from "@/store/statsStore";
import { DEFAULT_CLAUDE_ID } from "@/lib/presets";
import { StatsHeatmap } from "@/components/stats/StatsHeatmap";
import { ModelsChart } from "@/components/stats/ModelsChart";
import { PageActions } from "@/components/PageActions";
import type { DailyTokens, StatsTab, TimeRange, TokenStats } from "@/types/stats";

export default function StatsPage() {
  const { platforms, loadPlatforms } = usePlatformStore();
  const { cache, loading, error, loadStats } = useStatsStore();

  const [selectedPlatformId, setSelectedPlatformId] = useState<string>(DEFAULT_CLAUDE_ID);
  const [tab, setTab] = useState<StatsTab>("overview");
  const [range, setRange] = useState<TimeRange>("all");

  useEffect(() => {
    loadPlatforms();
  }, [loadPlatforms]);

  useEffect(() => {
    if (selectedPlatformId) {
      loadStats(selectedPlatformId);
    }
  }, [selectedPlatformId, loadStats]);

  const sortedPlatforms = useMemo(
    () => [...platforms].sort((a, b) => a.order - b.order),
    [platforms]
  );

  const stats = cache[selectedPlatformId];
  const isLoading = loading[selectedPlatformId];
  const errMsg = error[selectedPlatformId];

  const filtered = useMemo(() => {
    if (!stats) return null;
    return filterStatsByRange(stats, range);
  }, [stats, range]);

  const selectedPlatform = sortedPlatforms.find((p) => p.id === selectedPlatformId);

  return (
    <div>
      <PageActions>
        <button
          onClick={() => loadStats(selectedPlatformId, true)}
          disabled={isLoading}
          className="p-1.5 rounded-md hover:bg-muted transition-colors disabled:opacity-50 disabled:hover:bg-transparent text-muted-foreground hover:text-foreground"
          title="刷新"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </PageActions>

      <div className="p-6 pb-12 max-w-5xl mx-auto">
      {/* 平台选择器 */}
      <div className="mb-5">
        <div className="text-xs text-muted-foreground mb-2">选择平台</div>
        <div className="flex flex-wrap gap-2">
          {sortedPlatforms.map((p) => {
            const active = p.id === selectedPlatformId;
            return (
              <button
                key={p.id}
                onClick={() => setSelectedPlatformId(p.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card hover:bg-secondary border-border"
                }`}
              >
                <img
                  src={`/platform-icons/${p.icon || "default.svg"}`}
                  alt=""
                  className="w-4 h-4 object-contain"
                />
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 主面板 */}
      <div className="border rounded-lg bg-card overflow-hidden">
        {/* Tab 与时间范围 */}
        <div className="flex items-center justify-between p-3 border-b">
          <div className="flex gap-1">
            <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
              概览
            </TabButton>
            <TabButton active={tab === "models"} onClick={() => setTab("models")}>
              模型
            </TabButton>
          </div>
          <div className="flex gap-1">
            <RangeButton active={range === "all"} onClick={() => setRange("all")}>
              全部
            </RangeButton>
            <RangeButton active={range === "30d"} onClick={() => setRange("30d")}>
              近30天
            </RangeButton>
            <RangeButton active={range === "7d"} onClick={() => setRange("7d")}>
              近7天
            </RangeButton>
          </div>
        </div>

        <div className="p-5 min-h-[420px]">
          {isLoading && (
            <div className="text-center text-muted-foreground text-sm py-12">
              正在解析会话记录...
            </div>
          )}

          {!isLoading && errMsg && (
            <div className="text-center text-destructive text-sm py-12">
              加载失败：{errMsg}
            </div>
          )}

          {!isLoading && !errMsg && filtered && !filtered.exists && (
            <div className="text-center text-muted-foreground text-sm py-12">
              <div>未找到该平台的会话数据</div>
              <div className="text-xs mt-1.5 opacity-70">
                目录: {filtered.configDir || "(未配置)"}
              </div>
              <div className="text-xs mt-0.5 opacity-70">
                {selectedPlatform?.name === "Claude"
                  ? "请先使用 Claude Code 启动一次会话"
                  : "请通过 JCode 启动该平台并完成至少一次对话"}
              </div>
            </div>
          )}

          {!isLoading && !errMsg && filtered && filtered.exists && (
            <>
              {tab === "overview" ? (
                <OverviewView stats={filtered} />
              ) : (
                <ModelsView stats={filtered} />
              )}
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        active
          ? "bg-secondary font-medium"
          : "text-muted-foreground hover:bg-secondary/60"
      }`}
    >
      {children}
    </button>
  );
}

function RangeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
        active
          ? "bg-secondary font-medium"
          : "text-muted-foreground hover:bg-secondary/60"
      }`}
    >
      {children}
    </button>
  );
}

function OverviewView({ stats }: { stats: TokenStats }) {
  const totalTokens = stats.daily.reduce(
    (sum, d) => sum + Object.values(d.tokensByModel).reduce((a, b) => a + b, 0),
    0
  );

  return (
    <div>
      {/* 第一行：4 个主要统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <StatCard label="会话数" value={stats.totalSessions.toLocaleString()} />
        <StatCard label="消息数" value={stats.totalMessages.toLocaleString()} />
        <StatCard label="总 Token 数" value={formatLarge(totalTokens)} />
        <StatCard label="活跃天数" value={stats.activeDays.toLocaleString()} />
      </div>

      {/* 第二行：4 个次要统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard label="当前连续天数" value={`${stats.currentStreak} 天`} />
        <StatCard label="最长连续天数" value={`${stats.longestStreak} 天`} />
        <StatCard
          label="活跃时段"
          value={stats.peakHour !== null ? formatHour(stats.peakHour) : "—"}
        />
        <StatCard label="最常用模型" value={stats.favoriteModel ?? "—"} small />
      </div>

      {/* 热力图 */}
      <div className="border-t pt-4">
        <StatsHeatmap daily={stats.daily} />
        <div className="text-xs text-muted-foreground mt-2">
          {totalTokens > 0
            ? `所选时段共消耗约 ${formatLarge(totalTokens)} tokens`
            : "所选时段暂无 token 数据"}
        </div>
      </div>
    </div>
  );
}

function ModelsView({ stats }: { stats: TokenStats }) {
  return (
    <ModelsChart daily={stats.daily} modelUsage={stats.modelUsage} />
  );
}

function StatCard({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-semibold tabular-nums ${
          small ? "text-sm truncate" : "text-xl"
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function formatLarge(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatHour(h: number): string {
  if (h === 0) return "凌晨 0 点";
  if (h < 6) return `凌晨 ${h} 点`;
  if (h < 12) return `上午 ${h} 点`;
  if (h === 12) return "中午 12 点";
  if (h < 18) return `下午 ${h - 12} 点`;
  return `晚上 ${h - 12} 点`;
}

/** 按时间窗口过滤 daily 数据，并基于过滤后的数据重新聚合各项汇总指标 */
function filterStatsByRange(stats: TokenStats, range: TimeRange): TokenStats {
  let daily: DailyTokens[];
  if (range === "all") {
    daily = stats.daily;
  } else {
    const days = range === "7d" ? 7 : 30;
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - days + 1);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    daily = stats.daily.filter((d) => d.date >= cutoffISO);
  }

  // 按窗口聚合每模型 token 总量
  const usageMap = new Map<string, number>();
  for (const d of daily) {
    for (const [m, v] of Object.entries(d.tokensByModel)) {
      usageMap.set(m, (usageMap.get(m) ?? 0) + v);
    }
  }

  // 在窗口内按模型重新计算分摊（保留 input/output/cache 分类比例）
  const filteredModelUsage = stats.modelUsage
    .map((m) => {
      const fullTotal =
        m.inputTokens + m.outputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
      const windowTotal = usageMap.get(m.model) ?? 0;
      const ratio = fullTotal === 0 ? 0 : windowTotal / fullTotal;
      return {
        ...m,
        inputTokens: Math.round(m.inputTokens * ratio),
        outputTokens: Math.round(m.outputTokens * ratio),
        cacheReadInputTokens: Math.round(m.cacheReadInputTokens * ratio),
        cacheCreationInputTokens: Math.round(m.cacheCreationInputTokens * ratio),
        messageCount: Math.round(m.messageCount * ratio),
      };
    })
    .filter(
      (m) =>
        m.inputTokens +
          m.outputTokens +
          m.cacheReadInputTokens +
          m.cacheCreationInputTokens >
        0
    )
    .sort((a, b) => {
      const tb = b.inputTokens + b.outputTokens + b.cacheReadInputTokens + b.cacheCreationInputTokens;
      const ta = a.inputTokens + a.outputTokens + a.cacheReadInputTokens + a.cacheCreationInputTokens;
      return tb - ta;
    });

  // 唯一会话数：取窗口内每天 sessionIds 的并集
  const sessionSet = new Set<string>();
  for (const d of daily) {
    for (const sid of d.sessionIds ?? []) {
      sessionSet.add(sid);
    }
  }
  const messages = daily.reduce((s, d) => s + d.messageCount, 0);

  return {
    ...stats,
    daily,
    modelUsage: filteredModelUsage,
    totalSessions: sessionSet.size,
    totalMessages: messages,
    activeDays: daily.length,
    favoriteModel: filteredModelUsage[0]?.model ?? null,
  };
}
