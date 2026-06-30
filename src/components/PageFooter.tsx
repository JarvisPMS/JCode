import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * 把内容渲染到全局底部操作栏（#page-footer-slot），固定在主滚动区下方。
 *
 * 用法：把页面的关键操作按钮包在 <PageFooter> 里即可，无论页面内容多长，
 * 按钮始终可见，避免用户漏看。
 *
 * 当没有任何页面渲染 PageFooter 时，槽位为空，不占视觉空间。
 */
export function PageFooter({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("page-footer-slot"));
  }, []);
  if (!target) return null;
  return createPortal(<div className="page-footer">{children}</div>, target);
}
