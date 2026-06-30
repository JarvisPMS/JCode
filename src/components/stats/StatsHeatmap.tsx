import type { DailyTokens } from "@/types/stats";

interface Props {
  daily: DailyTokens[];
  weeks?: number;
}

/** 模仿 GitHub-style 热力图：横向 N 周 × 7 天 */
export function StatsHeatmap({ daily, weeks = 17 }: Props) {
  // 以最近 weeks*7 天为窗口
  const days = weeks * 7;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyMap = new Map<string, number>();
  for (const d of daily) {
    const total = Object.values(d.tokensByModel).reduce((a, b) => a + b, 0);
    dailyMap.set(d.date, total);
  }

  // 归一化：找最大值
  const maxValue = Math.max(...Array.from(dailyMap.values()), 1);

  // 生成网格：从今天往前 days 天
  const cells: { date: string; value: number; level: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const value = dailyMap.get(iso) ?? 0;
    let level = 0;
    if (value > 0) {
      const ratio = value / maxValue;
      if (ratio > 0.66) level = 4;
      else if (ratio > 0.33) level = 3;
      else if (ratio > 0.1) level = 2;
      else level = 1;
    }
    cells.push({ date: iso, value, level });
  }

  // 按周 column 排列
  const columns: typeof cells[] = [];
  for (let w = 0; w < weeks; w++) {
    columns.push(cells.slice(w * 7, w * 7 + 7));
  }

  const levelColors = [
    "bg-muted/60",
    "bg-blue-200 dark:bg-blue-900/60",
    "bg-blue-400 dark:bg-blue-700",
    "bg-blue-500 dark:bg-blue-500",
    "bg-blue-600 dark:bg-blue-400",
  ];

  return (
    <div className="flex gap-1 overflow-x-auto py-2">
      {columns.map((col, i) => (
        <div key={i} className="flex flex-col gap-1">
          {col.map((cell) => (
            <div
              key={cell.date}
              className={`w-3.5 h-3.5 rounded-sm ${levelColors[cell.level]}`}
              title={`${cell.date}：${formatTokens(cell.value)} tokens`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
