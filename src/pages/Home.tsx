import { useState, useCallback, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { Settings, Plus, CirclePlus, Sun, Moon, FlaskConical, BarChart3, Network } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { PlatformCard } from "@/components/PlatformCard";
import { Button } from "@/components/ui/button";
import { usePlatformStore } from "@/store/platformStore";
import { useDragDrop } from "@/hooks/useDragDrop";
import { pickDirectory } from "@/components/DirectoryPicker";
import { toast } from "@/components/Toast";
import type { PlatformConfig } from "@/types/platform";

export default function Home() {
  const {
    platforms,
    loading,
    loadPlatforms,
    deletePlatform,
    reorderPlatforms,
  } = usePlatformStore();
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  const toggleTheme = useCallback(() => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    loadPlatforms();
  }, [loadPlatforms]);

  const sorted = [...platforms]
    .filter((p) => p.enabled !== false)
    .sort((a, b) => a.order - b.order);

  const launchWithDir = useCallback(
    async (platformId: string, workDir: string) => {
      try {
        await invoke("launch_platform", { platformId, workDir });
        toast.success("已启动 Claude Code");
      } catch (err) {
        toast.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    []
  );

  const handleFileDrop = useCallback(
    async (platformId: string, paths: string[]) => {
      const path = paths[0];
      try {
        const isDir = await invoke<boolean>("is_directory", { path });
        if (!isDir) {
          toast.error("请拖入文件夹，而非文件");
          return;
        }
        await launchWithDir(platformId, path);
      } catch (err) {
        toast.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [launchWithDir]
  );

  const { isDraggingFile, hoveredCardId } = useDragDrop(handleFileDrop);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const ids = sorted.map((p) => p.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      const newIds = [...ids];
      newIds.splice(oldIndex, 1);
      newIds.splice(newIndex, 0, active.id as string);
      reorderPlatforms(newIds);
    }
  };

  const handleLaunch = useCallback(
    async (platform: PlatformConfig) => {
      if (platform.defaultWorkDir) {
        await launchWithDir(platform.id, platform.defaultWorkDir);
      } else {
        const dir = await pickDirectory();
        if (dir) {
          await launchWithDir(platform.id, dir);
        }
      }
    },
    [launchWithDir]
  );

  const handleEdit = useCallback(
    (platform: PlatformConfig) => {
      navigate(`/platform/edit/${platform.id}`);
    },
    [navigate]
  );

  const handleCopy = useCallback(async (platform: PlatformConfig) => {
    try {
      const apiKey = await invoke<string>("get_api_key", {
        platformId: platform.id,
      });
      const text = [
        `名称: ${platform.name}`,
        `BaseURL: ${platform.baseUrl}`,
        `APIKey: ${apiKey}`,
        `Model: ${platform.defaultModel}`,
      ].join("\n");
      await navigator.clipboard.writeText(text);
      toast.success(`已复制「${platform.name}」配置到剪贴板`);
    } catch (err) {
      toast.error(`复制失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<PlatformConfig | null>(null);

  const handleDelete = useCallback(
    (platform: PlatformConfig) => {
      setDeleteTarget(platform);
    },
    []
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deletePlatform(deleteTarget.id);
      toast.success(`已删除 ${deleteTarget.name}`);
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    setDeleteTarget(null);
  }, [deleteTarget, deletePlatform]);

  const activePlatform = activeId
    ? sorted.find((p) => p.id === activeId)
    : null;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground text-sm">加载中...</p>
      </div>
    );
  }

  return (
    <div className="p-6 pb-16 relative min-h-full">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sorted.map((p) => p.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-4">
            {sorted.map((platform) => (
              <PlatformCard
                key={platform.id}
                platform={platform}
                isDraggingFile={isDraggingFile}
                isFileHovered={hoveredCardId === platform.id}
                onLaunch={handleLaunch}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onCopy={handleCopy}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {activePlatform ? (
            <div className="flex flex-col items-center gap-1.5 p-2 pt-3 rounded-lg border-2 border-primary bg-card shadow-xl opacity-90">
              <div className="w-14 h-14 rounded-lg overflow-hidden">
                <img
                  src={`/platform-icons/${activePlatform.icon || "default.svg"}`}
                  alt={activePlatform.name}
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="font-medium text-xs">{activePlatform.name}</div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <p className="mb-4">还没有平台配置</p>
          <Button onClick={() => navigate("/platform/new")}>
            <Plus className="w-4 h-4 mr-1" />
            添加第一个平台
          </Button>
        </div>
      )}

      {/* 底部工具栏 */}
      <div className="fixed bottom-0 left-0 right-0 flex items-center justify-between px-4 py-2 z-40">
        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          title={dark ? "切换到浅色" : "切换到深色"}
        >
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate("/stats")}
            className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="Token 统计"
          >
            <BarChart3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate("/batch-test")}
            className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="批量测试"
          >
            <FlaskConical className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate("/proxy")}
            className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="本地代理"
          >
            <Network className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate("/platform/new")}
            className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="添加平台"
          >
            <CirclePlus className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate("/settings")}
            className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 删除确认 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-card border rounded-lg p-5 shadow-lg max-w-xs w-full mx-4">
            <p className="text-sm mb-4">
              确定删除平台「{deleteTarget.name}」？此操作不可撤销。
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={confirmDelete}
              >
                删除
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
