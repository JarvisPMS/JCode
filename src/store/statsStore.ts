import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { TokenStats } from "@/types/stats";

interface StatsStore {
  cache: Record<string, TokenStats>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  loadStats: (platformId: string, force?: boolean) => Promise<void>;
}

export const useStatsStore = create<StatsStore>((set, get) => ({
  cache: {},
  loading: {},
  error: {},

  loadStats: async (platformId, force = false) => {
    const { cache, loading } = get();
    if (loading[platformId]) return;
    if (!force && cache[platformId]) return;

    set((s) => ({
      loading: { ...s.loading, [platformId]: true },
      error: { ...s.error, [platformId]: null },
    }));

    try {
      const stats = await invoke<TokenStats>("get_token_stats", { platformId });
      set((s) => ({
        cache: { ...s.cache, [platformId]: stats },
        loading: { ...s.loading, [platformId]: false },
      }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [platformId]: false },
        error: {
          ...s.error,
          [platformId]: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },
}));
