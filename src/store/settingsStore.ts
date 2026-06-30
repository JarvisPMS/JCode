import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export type ProxyScope = "off" | "all" | "official";

export interface NetworkProxyConfig {
  host: string;
  port: string;
  scope: ProxyScope;
}

const DEFAULT_PROXY: NetworkProxyConfig = {
  host: "",
  port: "",
  scope: "off",
};

interface SettingsStore {
  permissionMode: PermissionMode;
  networkProxy: NetworkProxyConfig;
  loading: boolean;
  loadSettings: () => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  setNetworkProxy: (config: NetworkProxyConfig) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  permissionMode: "default",
  networkProxy: DEFAULT_PROXY,
  loading: true,

  loadSettings: async () => {
    try {
      const [mode, proxy] = await Promise.all([
        invoke<string>("get_permission_mode"),
        invoke<NetworkProxyConfig>("get_network_proxy_config"),
      ]);
      set({
        permissionMode: mode as PermissionMode,
        networkProxy: { ...DEFAULT_PROXY, ...proxy },
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  setPermissionMode: async (mode: PermissionMode) => {
    await invoke("save_permission_mode", { mode });
    set({ permissionMode: mode });
  },

  setNetworkProxy: async (config: NetworkProxyConfig) => {
    await invoke("save_network_proxy_config", { config });
    set({ networkProxy: config });
  },
}));
