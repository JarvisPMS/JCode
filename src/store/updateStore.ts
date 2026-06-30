import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { toast } from "@/components/Toast";

/**
 * 升级模式：
 *   - "manual" 手动：下载完成后仅在界面显示「重启更新」图标，用户点击才安装。
 *   - "silent" 无感：下载完成后，在主窗口隐藏到托盘时自动安装并重启；
 *               若窗口正可见，则退化为显示重启图标（避免打断正在操作的用户）。
 */
export type UpdateMode = "manual" | "silent";

export type UpdateStatus =
  | "idle" // 无更新 / 初始
  | "checking" // 正在检查
  | "downloading" // 后台下载中
  | "ready" // 已下载完成，待安装
  | "installing" // 正在安装并重启
  | "error";

const SETTINGS_STORE = "settings.json";
const UPDATE_MODE_KEY = "autoUpdateMode";

interface UpdateState {
  status: UpdateStatus;
  mode: UpdateMode;
  currentVersion: string;
  newVersion: string | null;
  notes: string | null;
  progress: number; // 0 - 100
  error: string | null;
  /** 挂起的 Update 句柄（download 之后、install 之前持有） */
  update: Update | null;
  /** 是否已注册「窗口隐藏即安装」监听，避免重复注册 */
  silentArmed: boolean;

  /** 应用启动时调用：读取当前版本与模式，并静默检查一次 */
  init: () => Promise<void>;
  /** 切换升级模式并持久化 */
  setMode: (mode: UpdateMode) => Promise<void>;
  /**
   * 检查更新。auto=true 时为后台静默检查：无更新或出错均不弹提示。
   * 发现新版本会立即开始后台下载。
   */
  checkForUpdate: (opts?: { auto?: boolean }) => Promise<void>;
  /** 安装已下载的更新并重启 */
  installAndRelaunch: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  mode: "manual",
  currentVersion: "",
  newVersion: null,
  notes: null,
  progress: 0,
  error: null,
  update: null,
  silentArmed: false,

  init: async () => {
    try {
      const version = await getVersion();
      set({ currentVersion: version });
    } catch {
      /* 取版本失败不致命 */
    }
    try {
      const store = await load(SETTINGS_STORE);
      const mode = (await store.get<UpdateMode>(UPDATE_MODE_KEY)) ?? "manual";
      set({ mode });
    } catch {
      /* store 读取失败时保持默认 manual */
    }
    // 启动后静默检查一次
    await get().checkForUpdate({ auto: true });
  },

  setMode: async (mode) => {
    set({ mode });
    try {
      const store = await load(SETTINGS_STORE);
      await store.set(UPDATE_MODE_KEY, mode);
      await store.save();
    } catch {
      /* 持久化失败仅影响下次启动的默认值 */
    }
    // 若切到无感模式且已下载完成，立即尝试在窗口隐藏时安装
    if (mode === "silent" && get().status === "ready") {
      void armSilentInstall(get, set);
    }
  },

  checkForUpdate: async ({ auto = false }: { auto?: boolean } = {}) => {
    const { status } = get();
    // 已在下载或下载完成，无需重复检查
    if (status === "downloading" || status === "ready" || status === "installing") {
      return;
    }
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (!update) {
        set({ status: "idle", newVersion: null });
        if (!auto) toast.success("当前已是最新版本");
        return;
      }

      set({
        status: "downloading",
        update,
        newVersion: update.version,
        notes: update.body ?? null,
        progress: 0,
      });

      // 后台下载（不安装），累计进度
      let total = 0;
      let received = 0;
      await update.download((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            received = 0;
            set({ progress: 0 });
            break;
          case "Progress":
            received += event.data.chunkLength;
            if (total > 0) {
              set({ progress: Math.min(100, Math.round((received / total) * 100)) });
            }
            break;
          case "Finished":
            set({ progress: 100 });
            break;
        }
      });

      set({ status: "ready" });

      if (get().mode === "silent") {
        // 无感模式：尝试在窗口隐藏时自动安装
        void armSilentInstall(get, set);
      } else if (!auto) {
        toast.success(`新版本 v${update.version} 已下载，点击标题栏图标即可重启更新`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: "error", error: message });
      if (!auto) toast.error(`检查更新失败：${message}`);
    }
  },

  installAndRelaunch: async () => {
    const { update, status } = get();
    if (!update || (status !== "ready" && status !== "error")) return;
    set({ status: "installing" });
    try {
      await update.install();
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: "ready", error: message });
      toast.error(`安装更新失败：${message}`);
    }
  },
}));

/**
 * 无感模式下，在主窗口隐藏到托盘时自动安装更新。
 * 若窗口当前已隐藏，立即安装；否则注册一次性焦点监听，
 * 待窗口失焦且不可见（被收进托盘）时安装。重启图标仍作为手动兜底保留。
 */
async function armSilentInstall(
  get: () => UpdateState,
  set: (partial: Partial<UpdateState>) => void,
) {
  if (get().silentArmed) return;
  set({ silentArmed: true });

  const win = getCurrentWindow();

  const tryInstall = async () => {
    if (get().status !== "ready") return;
    const visible = await win.isVisible().catch(() => true);
    if (!visible) {
      await get().installAndRelaunch();
    }
  };

  // 窗口当前就隐藏在托盘 → 直接安装
  if (!(await win.isVisible().catch(() => true))) {
    await get().installAndRelaunch();
    return;
  }

  // 否则等到窗口失焦（通常是被收进托盘）再判定
  await win.onFocusChanged(({ payload: focused }) => {
    if (!focused) void tryInstall();
  });
}
