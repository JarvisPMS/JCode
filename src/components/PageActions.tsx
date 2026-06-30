import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * 把内容渲染到 TitleBar 的右侧操作槽位（#titlebar-actions）。
 * 用于子页面在标题栏右边追加按钮（例如 Token 统计的刷新按钮）。
 */
export function PageActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("titlebar-actions"));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}
