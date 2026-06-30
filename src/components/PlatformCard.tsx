import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Trash2, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_CLAUDE_ID } from "@/lib/presets";
import type { PlatformConfig } from "@/types/platform";

interface PlatformCardProps {
  platform: PlatformConfig;
  isDraggingFile?: boolean;
  isFileHovered?: boolean;
  onLaunch: (platform: PlatformConfig) => void;
  onEdit: (platform: PlatformConfig) => void;
  onDelete: (platform: PlatformConfig) => void;
  onCopy: (platform: PlatformConfig) => void;
}

export function PlatformCard({
  platform,
  isDraggingFile,
  isFileHovered,
  onLaunch,
  onEdit,
  onDelete,
  onCopy,
}: PlatformCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: platform.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isDefault = platform.id === DEFAULT_CLAUDE_ID;

  // 协议标识：与后端 claude_route() 一致——原生 Anthropic 直连 > OpenAI 经代理 > 无端点
  const hasAnthropic = !!platform.baseUrl?.trim();
  const hasOpenAI = !!platform.openaiBaseUrl?.trim();
  const routeBadge = isDefault
    ? null
    : hasAnthropic
      ? {
          label: "A",
          cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
          title: "Anthropic 原生端点 · 直连",
        }
      : hasOpenAI && platform.anthropicCompatViaProxy
        ? {
            label: "O",
            cls: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
            title: "OpenAI 兼容 · 经本地代理转协议",
          }
        : {
            label: "!",
            cls: "bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400",
            title: "无可用端点，无法启动（需 Anthropic 端点，或 OpenAI 端点 + 兼容开关）",
          };

  const iconSrc = platform.icon.startsWith("http")
    ? platform.icon
    : `/platform-icons/${platform.icon || "default.svg"}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      data-platform-id={platform.id}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "group relative flex flex-col items-center gap-2.5 p-2 pt-3 pb-3 rounded-lg border bg-card transition-all duration-150 select-none",
        isDragging && "opacity-50 scale-105 z-50",
        isFileHovered
          ? "border-primary shadow-lg scale-105"
          : isDraggingFile
            ? "border-muted-foreground/40"
            : "border-border hover:border-primary hover:shadow-md hover:scale-105"
      )}
    >
      {/* 协议标识：默认显示，hover 时淡出让位给拖拽手柄 */}
      {routeBadge && (
        <div
          className={cn(
            "absolute top-1 left-1 w-3.5 h-3.5 flex items-center justify-center rounded text-[10px] font-semibold leading-none pointer-events-none z-10 opacity-100 group-hover:opacity-0 transition-opacity",
            routeBadge.cls
          )}
          title={routeBadge.title}
        >
          {routeBadge.label}
        </div>
      )}

      {/* hover 操作：左上拖拽 + 右上删除 + 右下编辑 */}
      <div className="absolute top-0.5 left-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <div
          {...listeners}
          className="p-0.5 rounded hover:bg-muted cursor-grab active:cursor-grabbing"
          title="拖拽排序"
        >
          <GripVertical className="w-3 h-3 text-muted-foreground" />
        </div>
      </div>
      {!isDefault && (
        <>
          <button
            className="absolute top-0.5 right-0.5 p-0.5 rounded hover:bg-destructive/10 transition-colors delayed-show z-10"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(platform);
            }}
          >
            <Trash2 className="w-3 h-3 text-destructive/70" />
          </button>
          <button
            className="absolute bottom-0.5 right-0.5 p-0.5 rounded hover:bg-muted transition-colors delayed-show z-10"
            title="编辑"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(platform);
            }}
          >
            <Pencil className="w-3 h-3 text-muted-foreground" />
          </button>
          <button
            className="absolute bottom-0.5 left-0.5 p-0.5 rounded hover:bg-muted transition-colors delayed-show z-10"
            title="复制配置（名称 / 接入点 / 密钥 / 模型）"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(platform);
            }}
          >
            <Copy className="w-3 h-3 text-muted-foreground" />
          </button>
        </>
      )}

      {/* 点击启动 */}
      <div
        className="flex flex-col items-center gap-1.5 cursor-pointer w-full"
        onClick={() => onLaunch(platform)}
      >
        <div className="w-11 h-11 rounded-lg overflow-hidden flex items-center justify-center">
          <img
            src={iconSrc}
            alt={platform.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>
        <div className="font-medium text-xs text-center leading-tight truncate w-full">
          {isFileHovered ? (
            <span className="text-primary">松开启动</span>
          ) : (
            <>
              <span className="group-hover:hidden">{platform.name}</span>
              <span className="hidden group-hover:inline text-primary">点击启动</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
