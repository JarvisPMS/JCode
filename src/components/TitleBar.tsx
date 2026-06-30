import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  Settings as SettingsIcon,
  FlaskConical,
  BarChart3,
  Network,
  CirclePlus,
  Pencil,
  List,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import { useUpdateStore } from "@/store/updateStore";

const appWindow = getCurrentWindow();

interface PageMeta {
  title: string;
  Icon: LucideIcon;
}

function getPageMeta(pathname: string): PageMeta | null {
  if (pathname === "/settings") return { title: "设置", Icon: SettingsIcon };
  if (pathname === "/batch-test") return { title: "批量测试", Icon: FlaskConical };
  if (pathname === "/stats") return { title: "Token 统计", Icon: BarChart3 };
  if (pathname === "/proxy") return { title: "本地代理", Icon: Network };
  if (pathname === "/platform/list") return { title: "平台列表", Icon: List };
  if (pathname === "/platform/new") return { title: "添加平台", Icon: CirclePlus };
  if (pathname.startsWith("/platform/edit/"))
    return { title: "编辑平台", Icon: Pencil };
  return null;
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const meta = getPageMeta(location.pathname);

  useEffect(() => {
    const syncMaximized = async () => {
      const value = await appWindow.isMaximized();
      setMaximized(value);
      document.body.classList.toggle("window-maximized", value);
    };

    syncMaximized();

    let unlistenResize: (() => void) | undefined;
    appWindow.onResized(syncMaximized).then((fn) => { unlistenResize = fn; });

    // 窗口从隐藏/最小化恢复时，清除按钮残留的 :hover 状态
    // WebView2 在窗口不可见期间不触发 mouseleave，:hover 伪类会残留
    // 方案：失焦时冻结（CSS class 强制覆盖 hover），鼠标移动后解冻
    let unlistenFocus: (() => void) | undefined;
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        setFrozen(true);
      } else {
        const handler = () => { setFrozen(false); };
        document.addEventListener("mousemove", handler, { once: true });
      }
    }).then((fn) => { unlistenFocus = fn; });

    return () => {
      unlistenResize?.();
      unlistenFocus?.();
      document.body.classList.remove("window-maximized");
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="titlebar"
    >
      {meta ? (
        <div data-tauri-drag-region className="titlebar-title titlebar-subpage">
          <button
            className="titlebar-back"
            onClick={() => navigate("/")}
            title="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <meta.Icon className="w-4 h-4 text-primary" />
          <span className="titlebar-subpage-name">{meta.title}</span>
          <div id="titlebar-actions" className="titlebar-actions" />
        </div>
      ) : (
        <div data-tauri-drag-region className="titlebar-title">
          <img src="/logo.png" alt="" className="titlebar-logo" draggable={false} />
          Code
        </div>
      )}
      <div className={`titlebar-controls${frozen ? " titlebar-frozen" : ""}`}>
        <UpdateIndicator />
        <button
          className="titlebar-btn"
          onClick={() => appWindow.minimize()}
          title="最小化"
        >
          {/* ─ 最小化 */}
          <svg width="10" height="1" viewBox="0 0 10 1">
            <line
              x1="0" y1="0.5" x2="10" y2="0.5"
              stroke="currentColor" strokeWidth="1"
            />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
        >
          {maximized ? (
            /* 还原：两个重叠矩形 */
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <polyline
                points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5"
                stroke="currentColor" strokeWidth="1"
              />
              <rect
                x="0.5" y="2.5" width="7" height="7"
                stroke="currentColor" strokeWidth="1"
              />
            </svg>
          ) : (
            /* □ 最大化 */
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect
                x="0.5" y="0.5" width="9" height="9"
                stroke="currentColor" strokeWidth="1"
              />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={() => appWindow.close()}
          title="关闭"
        >
          {/* ✕ 关闭 */}
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line
              x1="1" y1="1" x2="9" y2="9"
              stroke="currentColor" strokeWidth="1.2"
            />
            <line
              x1="9" y1="1" x2="1" y2="9"
              stroke="currentColor" strokeWidth="1.2"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * 更新指示器：下载完成（status=ready）后在标题栏显示「重启更新」图标，
 * 点击即安装并重启。安装中显示旋转动画。其余状态不渲染。
 */
function UpdateIndicator() {
  const status = useUpdateStore((s) => s.status);
  const newVersion = useUpdateStore((s) => s.newVersion);
  const installAndRelaunch = useUpdateStore((s) => s.installAndRelaunch);

  if (status !== "ready" && status !== "installing") return null;

  const installing = status === "installing";
  return (
    <button
      className="titlebar-btn titlebar-btn-update"
      onClick={() => !installing && installAndRelaunch()}
      disabled={installing}
      title={installing ? "正在更新…" : `重启以更新到 v${newVersion ?? ""}`}
    >
      <RotateCw className={`w-3.5 h-3.5${installing ? " animate-spin" : ""}`} />
    </button>
  );
}
