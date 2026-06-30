import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ProxyConfig, ProxyStatus } from "@/types/proxy";

const DEFAULT_SOURCE_MODELS = [
  "claude-sonnet-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

interface ProxyStore {
  config: ProxyConfig;
  status: ProxyStatus;
  loading: boolean;
  load: () => Promise<void>;
  save: (config: ProxyConfig) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

export const useProxyStore = create<ProxyStore>((set, get) => ({
  config: { port: 8765, mappings: [] },
  status: { running: false, port: null },
  loading: true,

  load: async () => {
    try {
      const [config, status] = await Promise.all([
        invoke<ProxyConfig>("get_proxy_config"),
        invoke<ProxyStatus>("get_proxy_status"),
      ]);
      // 首次加载若无映射，给三个常见 Claude 模型名占位（用户可自行修改/删除）
      if (!config.mappings || config.mappings.length === 0) {
        config.mappings = DEFAULT_SOURCE_MODELS.map((sourceModel) => ({
          id: crypto.randomUUID(),
          sourceModel,
          targetPlatformId: "",
          targetModel: "",
        }));
      }
      set({ config, status, loading: false });
    } catch (err) {
      console.error("Failed to load proxy config:", err);
      set({ loading: false });
    }
  },

  save: async (config) => {
    await invoke("save_proxy_config", { config });
    set({ config });
  },

  start: async () => {
    const { config } = get();
    await invoke("start_proxy", { port: config.port });
    await get().refreshStatus();
  },

  stop: async () => {
    await invoke("stop_proxy");
    await get().refreshStatus();
  },

  refreshStatus: async () => {
    const status = await invoke<ProxyStatus>("get_proxy_status");
    set({ status });
  },
}));
