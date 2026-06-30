import { ArrowUp, ArrowDown } from "lucide-react";
import type { DailyTokens, ModelUsage } from "@/types/stats";

interface Props {
  daily: DailyTokens[];
  modelUsage: ModelUsage[];
}

const MODEL_COLORS = [
  "#1d4ed8",
  "#3b82f6",
  "#60a5fa",
  "#93c5fd",
  "#bfdbfe",
  "#a855f7",
  "#c084fc",
  "#f59e0b",
  "#fbbf24",
  "#10b981",
  "#34d399",
  "#ef4444",
];

/** 堆叠柱状图：每天按模型堆叠 token 用量 */
export function ModelsChart({ daily, modelUsage }: Props) {
  const models = modelUsage.map((m) => m.model);
  const colorMap = new Map(models.map((m, i) => [m, MODEL_COLORS[i % MODEL_COLORS.length]]));

  if (daily.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-12">
        所选时段内暂无数据
      </div>
    );
  }

  // 计算每日总量
  const dayTotals = daily.map((d) => ({
    date: d.date,
    tokensByModel: d.tokensByModel,
    total: Object.values(d.tokensByModel).reduce((a, b) => a + b, 0),
  }));

  const maxTotal = Math.max(...dayTotals.map((d) => d.total), 1);

  // Y 轴刻度
  const niceMax = niceCeil(maxTotal);
  const ticks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];

  const barCount = dayTotals.length;
  const chartHeight = 220;
  const chartWidth = 100; // %

  return (
    <div className="w-full">
      <div className="relative" style={{ height: chartHeight + 30 }}>
        {/* Y 轴刻度与网格 */}
        <div className="absolute inset-0 flex flex-col justify-between" style={{ height: chartHeight }}>
          {ticks.slice().reverse().map((t, i) => (
            <div key={i} className="flex items-center w-full text-xs text-muted-foreground">
              <span className="w-12 text-right pr-2 tabular-nums">{formatTokens(t)}</span>
              <div className="flex-1 border-t border-dashed border-border/60" />
            </div>
          ))}
        </div>

        {/* 柱状图区 */}
        <div
          className="absolute left-12 right-0 flex items-end gap-1"
          style={{ height: chartHeight }}
        >
          {dayTotals.map((day) => (
            <div key={day.date} className="flex-1 flex flex-col items-center group">
              <div className="w-full flex flex-col-reverse" style={{ height: chartHeight }}>
                {models.map((model) => {
                  const v = day.tokensByModel[model] ?? 0;
                  if (v === 0) return null;
                  const h = (v / niceMax) * chartHeight;
                  return (
                    <div
                      key={model}
                      className="w-full transition-opacity hover:opacity-80"
                      style={{ height: h, backgroundColor: colorMap.get(model) }}
                      title={`${day.date}\n${model}: ${formatTokens(v)}`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* X 轴标签 */}
        <div
          className="absolute left-12 right-0 flex gap-1 mt-1"
          style={{ top: chartHeight + 4 }}
        >
          {dayTotals.map((day, i) => {
            // 控制标签密度：最多显示 ~10 个
            const showLabel = i % Math.max(1, Math.ceil(barCount / 10)) === 0 || i === barCount - 1;
            return (
              <div key={day.date} className="flex-1 text-center text-xs text-muted-foreground">
                {showLabel ? formatDateShort(day.date) : ""}
              </div>
            );
          })}
        </div>

        {/* 占位让宽度撑开 */}
        <div style={{ width: chartWidth + "%" }} />
      </div>

      {/* 图例 + 模型 token 明细 */}
      <div className="mt-8 space-y-3">
        {modelUsage.map((m) => {
          const total =
            m.inputTokens + m.outputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
          const totalAll = modelUsage.reduce(
            (s, x) =>
              s +
              x.inputTokens +
              x.outputTokens +
              x.cacheReadInputTokens +
              x.cacheCreationInputTokens,
            0
          );
          const pct = totalAll === 0 ? 0 : (total / totalAll) * 100;
          const totalInputLike =
            m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
          const hitRate =
            totalInputLike > 0 ? (m.cacheReadInputTokens / totalInputLike) * 100 : 0;
          return (
            <div key={m.model} className="text-sm">
              {/* 第一行：色块 + 模型名 + 占比 */}
              <div className="flex items-center gap-3">
                <div
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: colorMap.get(m.model) }}
                />
                <div className="flex-1 truncate font-medium">{m.model}</div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {pct.toFixed(1)}%
                </div>
              </div>
              {/* 第二行：分项明细（↑ = 输入面 3 项 / ↓ = 输出面 1 项） */}
              <div className="ml-6 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                <span className="inline-flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 text-sky-500/80" />
                  输入 {formatTokens(m.inputTokens)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 text-sky-500/80" />
                  缓存命中 {formatTokens(m.cacheReadInputTokens)}
                  {m.cacheReadInputTokens > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400 ml-0.5">
                      ({hitRate.toFixed(0)}%)
                    </span>
                  )}
                </span>
                <span className="inline-flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 text-sky-500/80" />
                  缓存写入 {formatTokens(m.cacheCreationInputTokens)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <ArrowDown className="w-3 h-3 text-amber-500/80" />
                  输出 {formatTokens(m.outputTokens)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(0);
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const m = n / base;
  let nice;
  if (m <= 1) nice = 1;
  else if (m <= 1.5) nice = 1.5;
  else if (m <= 2) nice = 2;
  else if (m <= 3) nice = 3;
  else if (m <= 5) nice = 5;
  else if (m <= 7) nice = 7;
  else nice = 10;
  return nice * base;
}
