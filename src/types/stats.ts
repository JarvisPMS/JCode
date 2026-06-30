export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  messageCount: number;
}

export interface DailyTokens {
  date: string;
  tokensByModel: Record<string, number>;
  messageCount: number;
  sessionCount: number;
  sessionIds: string[];
}

export interface TokenStats {
  platformId: string;
  configDir: string;
  exists: boolean;
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  firstSessionDate: string | null;
  lastSessionDate: string | null;
  daily: DailyTokens[];
  modelUsage: ModelUsage[];
  hourCounts: Record<string, number>;
}

export type TimeRange = "all" | "30d" | "7d";
export type StatsTab = "overview" | "models";
