import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { PlatformConfig } from "@/types/platform";
import { PLATFORM_PRESETS, DEFAULT_CLAUDE_ID } from "@/lib/presets";

interface PlatformStore {
  platforms: PlatformConfig[];
  loading: boolean;
  loadPlatforms: () => Promise<void>;
  addPlatform: (
    config: Omit<PlatformConfig, "id" | "order">,
    apiKey: string
  ) => Promise<void>;
  updatePlatform: (
    id: string,
    config: Omit<PlatformConfig, "id" | "order">,
    apiKey: string
  ) => Promise<void>;
  deletePlatform: (id: string) => Promise<void>;
  reorderPlatforms: (orderedIds: string[]) => Promise<void>;
  setPlatformEnabled: (id: string, enabled: boolean) => Promise<void>;
}

let seedingPromise: Promise<void> | null = null;

function seedFromPresets(): Promise<void> {
  if (seedingPromise) return seedingPromise;
  seedingPromise = (async () => {
    // 全新安装只创建默认 Claude 卡片，其他平台由用户手动添加
    const claudePreset = PLATFORM_PRESETS.find((p) => p.fixedId === DEFAULT_CLAUDE_ID);
    if (claudePreset) {
      const { apiKey, fixedId, ...config } = claudePreset;
      const fullConfig: PlatformConfig = { ...config, id: DEFAULT_CLAUDE_ID, order: 0, models: config.models ?? "", enabled: true };
      await invoke("save_platform", { config: fullConfig, apiKey: null });
    }
  })();
  return seedingPromise;
}

export const usePlatformStore = create<PlatformStore>((set, get) => ({
  platforms: [],
  loading: true,

  loadPlatforms: async () => {
    try {
      let platforms = await invoke<PlatformConfig[]>("get_platforms");
      if (platforms.length === 0) {
        await seedFromPresets();
        platforms = await invoke<PlatformConfig[]>("get_platforms");
      }
      // 确保默认 Claude 卡片始终存在（兼容旧数据升级）
      if (!platforms.find((p) => p.id === DEFAULT_CLAUDE_ID)) {
        const defaultPreset = PLATFORM_PRESETS.find((p) => p.fixedId === DEFAULT_CLAUDE_ID);
        if (defaultPreset) {
          const { apiKey, fixedId, ...config } = defaultPreset;
          const fullConfig = { ...config, id: DEFAULT_CLAUDE_ID, order: 0, enabled: true };
          await invoke("save_platform", { config: fullConfig, apiKey: null });
          platforms = await invoke<PlatformConfig[]>("get_platforms");
        }
      }
      set({ platforms, loading: false });
    } catch (err) {
      console.error("Failed to load platforms:", err);
      set({ platforms: [], loading: false });
    }
  },

  addPlatform: async (config, apiKey) => {
    const id = crypto.randomUUID();
    const { platforms } = get();
    const fullConfig: PlatformConfig = {
      ...config,
      id,
      order: platforms.length,
    };
    await invoke("save_platform", {
      config: fullConfig,
      apiKey: apiKey || null,
    });
    set({ platforms: [...platforms, fullConfig] });
  },

  updatePlatform: async (id, config, apiKey) => {
    const { platforms } = get();
    const existing = platforms.find((p) => p.id === id);
    if (!existing) return;
    const fullConfig: PlatformConfig = { ...config, id, order: existing.order };
    await invoke("save_platform", {
      config: fullConfig,
      apiKey: apiKey || null,
    });
    set({
      platforms: platforms.map((p) => (p.id === id ? fullConfig : p)),
    });
  },

  deletePlatform: async (id) => {
    await invoke("delete_platform", { platformId: id });
    set({ platforms: get().platforms.filter((p) => p.id !== id) });
  },

  setPlatformEnabled: async (id, enabled) => {
    const { platforms } = get();
    const existing = platforms.find((p) => p.id === id);
    if (!existing) return;
    const updated = { ...existing, enabled };
    // 乐观更新
    set({ platforms: platforms.map((p) => (p.id === id ? updated : p)) });
    try {
      // apiKey 传 null，仅更新平台配置，不改动已存密钥
      await invoke("save_platform", { config: updated, apiKey: null });
    } catch (err) {
      console.error("Failed to toggle enabled:", err);
      set({ platforms });
    }
  },

  reorderPlatforms: async (orderedIds) => {
    const { platforms } = get();
    const platformMap = new Map(platforms.map((p) => [p.id, p]));
    const reordered = orderedIds
      .map((id, index) => {
        const platform = platformMap.get(id);
        return platform ? { ...platform, order: index } : null;
      })
      .filter((p): p is PlatformConfig => p !== null);
    set({ platforms: reordered });
    try {
      await invoke("reorder_platforms", { orderedIds });
    } catch (err) {
      console.error("Failed to reorder:", err);
      set({ platforms });
    }
  },
}));
