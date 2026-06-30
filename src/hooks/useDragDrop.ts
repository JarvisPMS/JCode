import { useState, useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface DragDropState {
  isDraggingFile: boolean;
  hoveredCardId: string | null;
}

/** Tauri 返回物理像素坐标，elementFromPoint 需要 CSS 逻辑像素 */
function findPlatformIdFromPoint(physX: number, physY: number): string | null {
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(physX / scale, physY / scale);
  if (!el) return null;
  const card = (el as HTMLElement).closest("[data-platform-id]");
  return card?.getAttribute("data-platform-id") ?? null;
}

export function useDragDrop(
  onFileDrop: (platformId: string, paths: string[]) => void
): DragDropState {
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const lastDropTime = useRef(0);

  const onFileDropRef = useRef(onFileDrop);
  onFileDropRef.current = onFileDrop;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      const webview = getCurrentWebview();
      const fn = await webview.onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          setIsDraggingFile(true);
        } else if (event.payload.type === "over") {
          const { x, y } = event.payload.position;
          const id = findPlatformIdFromPoint(x, y);
          hoveredRef.current = id;
          setHoveredCardId(id);
        } else if (event.payload.type === "leave") {
          setIsDraggingFile(false);
          setHoveredCardId(null);
          hoveredRef.current = null;
        } else if (event.payload.type === "drop") {
          // 防止 Windows 上同一次拖放触发多次 drop 事件
          const now = Date.now();
          if (now - lastDropTime.current < 3000) return;
          lastDropTime.current = now;

          const targetId = hoveredRef.current;
          const paths = event.payload.paths;

          setIsDraggingFile(false);
          setHoveredCardId(null);
          hoveredRef.current = null;

          if (targetId && paths.length > 0) {
            onFileDropRef.current(targetId, paths);
          }
        }
      });

      // StrictMode 下 cleanup 可能在 await 之前就跑了
      // 此时需要立即注销刚注册的监听器
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    };

    setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { isDraggingFile, hoveredCardId };
}
