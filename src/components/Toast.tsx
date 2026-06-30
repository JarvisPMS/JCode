import { useEffect, useState, useCallback, useRef } from "react";
import { CircleCheck, CircleX } from "lucide-react";

interface ToastItem {
  id: number;
  type: "success" | "error";
  message: string;
}

let _addToast: ((item: Omit<ToastItem, "id">) => void) | null = null;
let _nextId = 0;

export const toast = {
  success(message: string) {
    _addToast?.({ type: "success", message });
  },
  error(message: string) {
    _addToast?.({ type: "error", message });
  },
};

export function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const add = useCallback((item: Omit<ToastItem, "id">) => {
    const id = ++_nextId;
    setItems((prev) => [...prev, { ...item, id }]);
    const timer = setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, 3000);
    timers.current.set(id, timer);
  }, []);

  useEffect(() => {
    _addToast = add;
    return () => {
      _addToast = null;
      timers.current.forEach(clearTimeout);
    };
  }, [add]);

  if (items.length === 0) return null;

  return (
    <div className="fixed left-0 right-0 z-[9999] flex flex-col items-center gap-2 pointer-events-none"
      style={{ bottom: 48 }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto animate-in fade-in slide-in-from-bottom-2 duration-200"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderRadius: 10,
            fontSize: 13,
            fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.10)",
            maxWidth: 340,
            ...(item.type === "success"
              ? { background: "hsl(222.2 47.4% 11.2%)", color: "hsl(210 40% 98%)" }
              : { background: "hsl(0 72% 51%)", color: "white" }),
          }}
        >
          {item.type === "success" ? (
            <CircleCheck className="w-4 h-4 flex-shrink-0" style={{ color: "hsl(142 71% 65%)" }} />
          ) : (
            <CircleX className="w-4 h-4 flex-shrink-0" />
          )}
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}
