import * as React from "react";
import { cn } from "@/lib/utils";

interface ContextMenuProps {
  children: React.ReactNode;
  menu: React.ReactNode;
}

interface Position {
  x: number;
  y: number;
}

function ContextMenu({ children, menu }: ContextMenuProps) {
  const [position, setPosition] = React.useState<Position | null>(null);

  React.useEffect(() => {
    if (position) {
      const handler = () => setPosition(null);
      document.addEventListener("click", handler);
      document.addEventListener("contextmenu", handler);
      return () => {
        document.removeEventListener("click", handler);
        document.removeEventListener("contextmenu", handler);
      };
    }
  }, [position]);

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        setPosition({ x: e.clientX, y: e.clientY });
      }}
    >
      {children}
      {position && (
        <div
          className="fixed z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: position.x, top: position.y }}
        >
          {menu}
        </div>
      )}
    </div>
  );
}

function ContextMenuItem({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
        className
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-muted" />;
}

export { ContextMenu, ContextMenuItem, ContextMenuSeparator };
