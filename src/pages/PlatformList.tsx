import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Copy } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PageFooter } from "@/components/PageFooter";
import { usePlatformStore } from "@/store/platformStore";
import { toast } from "@/components/Toast";
import type { PlatformConfig } from "@/types/platform";

export default function PlatformList() {
  const navigate = useNavigate();
  const { platforms, loading, loadPlatforms, setPlatformEnabled } =
    usePlatformStore();

  useEffect(() => {
    loadPlatforms();
  }, [loadPlatforms]);

  const sorted = [...platforms].sort((a, b) => a.order - b.order);

  const handleToggle = async (platform: PlatformConfig, enabled: boolean) => {
    try {
      await setPlatformEnabled(platform.id, enabled);
    } catch (err) {
      toast.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCopy = async (platform: PlatformConfig) => {
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
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground text-sm">加载中...</p>
      </div>
    );
  }

  return (
    <div className="p-6 pb-20">
      <div className="max-w-lg mx-auto">
        <p className="text-xs text-muted-foreground mb-4">
          关闭开关可将平台从首屏隐藏，配置仍保留，可随时重新启用
        </p>

        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <p className="mb-4">还没有平台配置</p>
            <Button onClick={() => navigate("/platform/new")}>
              <Plus className="w-4 h-4 mr-1" />
              添加第一个平台
            </Button>
          </div>
        ) : (
          <div className="space-y-1.5">
            {sorted.map((platform) => {
              const iconSrc = platform.icon.startsWith("http")
                ? platform.icon
                : `/platform-icons/${platform.icon || "default.svg"}`;
              const enabled = platform.enabled !== false;
              return (
                <div
                  key={platform.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-card"
                >
                  <div className="w-9 h-9 rounded-md overflow-hidden flex items-center justify-center shrink-0">
                    <img
                      src={iconSrc}
                      alt={platform.name}
                      className="w-full h-full object-contain"
                      draggable={false}
                    />
                  </div>
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => navigate(`/platform/edit/${platform.id}`)}
                  >
                    <div className="text-sm font-medium truncate">{platform.name}</div>
                    <div className="text-xs text-muted-foreground truncate font-mono">
                      {platform.defaultModel || "—"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(platform)}
                    title="复制配置（名称 / 接入点 / 密钥 / 模型）"
                    className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => handleToggle(platform, v)}
                    title={enabled ? "已启用（首屏显示）" : "已停用（首屏隐藏）"}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <PageFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate("/platform/new")}
        >
          <Plus className="w-4 h-4 mr-1" />
          添加平台
        </Button>
        <div className="ml-auto">
          <Button type="button" size="sm" onClick={() => navigate("/")}>
            完成
          </Button>
        </div>
      </PageFooter>
    </div>
  );
}
