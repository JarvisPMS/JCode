import { useState, useRef, useEffect } from "react";
import { Download, Upload, KeyRound, Network, RotateCw, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import {
  useSettingsStore,
  type PermissionMode,
  type ProxyScope,
} from "@/store/settingsStore";
import { useUpdateStore, type UpdateMode } from "@/store/updateStore";

interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  notFound: number;
  failures: [string, string][];
}

const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  description: string;
  danger?: boolean;
}[] = [
  {
    value: "default",
    label: "默认模式",
    description: "每步操作均需手动确认，安全透明",
  },
  {
    value: "acceptEdits",
    label: "自动编辑",
    description: "文件修改自动批准，终端命令仍需确认",
  },
  {
    value: "plan",
    label: "仅规划",
    description: "只分析规划，不执行任何实际操作",
  },
  {
    value: "auto",
    label: "全自动",
    description: "Anthropic 官方推荐的安全自动运行模式",
  },
  {
    value: "dontAsk",
    label: "仅预批准",
    description: "只执行预设允许项，自动拒绝需询问的操作",
  },
  {
    value: "bypassPermissions",
    label: "跳过权限",
    description: "绕过全部权限检查，请谨慎使用",
    danger: true,
  },
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
      {children}
    </p>
  );
}

function Divider() {
  return <div className="border-t border-border" />;
}

const PROXY_SCOPES: { value: Exclude<ProxyScope, "off">; label: string; description: string }[] = [
  {
    value: "all",
    label: "代理全部",
    description: "对配置的所有平台生效",
  },
  {
    value: "official",
    label: "代理官方",
    description: "仅对内置的 Claude 官方平台生效",
  },
];

function NetworkProxySection() {
  const { networkProxy, setNetworkProxy } = useSettingsStore();
  const [host, setHost] = useState(networkProxy.host);
  const [port, setPort] = useState(networkProxy.port);

  // store 加载完成后同步到本地输入框
  useEffect(() => {
    setHost(networkProxy.host);
    setPort(networkProxy.port);
  }, [networkProxy.host, networkProxy.port]);

  const persist = async (next: { host?: string; port?: string; scope?: ProxyScope }) => {
    try {
      await setNetworkProxy({
        host: next.host ?? host,
        port: next.port ?? port,
        scope: next.scope ?? networkProxy.scope,
      });
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleScopeToggle = (value: Exclude<ProxyScope, "off">) => {
    const next: ProxyScope = networkProxy.scope === value ? "off" : value;
    persist({ scope: next });
  };

  const enabled = networkProxy.scope !== "off";
  const hasAddr = host.trim() !== "" && port.trim() !== "";

  return (
    <section>
      <SectionLabel>网络代理</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3 -mt-1">
        终端无法全局代理时，启动 Claude Code 时注入 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
        环境变量。协议会自动补全，只需填写 IP 与端口
      </p>

      <div className="flex items-center gap-2 mb-3">
        <Network className="w-4 h-4 text-muted-foreground shrink-0" />
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onBlur={() => persist({ host })}
          placeholder="127.0.0.1"
          className="h-9 flex-1"
          spellCheck={false}
        />
        <span className="text-muted-foreground">:</span>
        <Input
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => persist({ port })}
          placeholder="9527"
          inputMode="numeric"
          className="h-9 w-24"
          spellCheck={false}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {PROXY_SCOPES.map((scope) => {
          const active = networkProxy.scope === scope.value;
          return (
            <div
              key={scope.value}
              onClick={() => handleScopeToggle(scope.value)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md border cursor-pointer transition-colors select-none",
                active
                  ? "border-primary/60 bg-primary/5"
                  : "border-transparent bg-muted/40 hover:bg-muted/70"
              )}
            >
              <div
                className={cn(
                  "w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                  active ? "border-primary bg-primary" : "border-muted-foreground/40"
                )}
              >
                {active && (
                  <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-primary-foreground" fill="none">
                    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0 flex items-baseline gap-2">
                <span className="text-sm font-medium">{scope.label}</span>
                <span className="text-xs text-muted-foreground truncate">— {scope.description}</span>
              </div>
            </div>
          );
        })}
      </div>

      {enabled && hasAddr && (
        <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          <div>HTTP_PROXY=http://{host.trim()}:{port.trim()}</div>
          <div>HTTPS_PROXY=http://{host.trim()}:{port.trim()}</div>
          <div>ALL_PROXY=socks5h://{host.trim()}:{port.trim()}</div>
        </div>
      )}
      {enabled && !hasAddr && (
        <p className="mt-2 text-xs text-destructive/80">请填写代理 IP 与端口后才会生效</p>
      )}
    </section>
  );
}

const UPDATE_MODES: { value: UpdateMode; label: string; description: string }[] = [
  {
    value: "manual",
    label: "手动点击重启",
    description: "后台下载完成后，标题栏出现图标，点击才更新",
  },
  {
    value: "silent",
    label: "退出时自动升级",
    description: "后台下载完成后，收进托盘时自动安装，下次打开即新版",
  },
];

function UpdateSection() {
  const {
    status,
    mode,
    currentVersion,
    newVersion,
    progress,
    checkForUpdate,
    installAndRelaunch,
    setMode,
  } = useUpdateStore();

  const checking = status === "checking";
  const downloading = status === "downloading";
  const ready = status === "ready";
  const installing = status === "installing";

  return (
    <section>
      <SectionLabel>软件更新</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3 -mt-1">
        当前版本 v{currentVersion || "—"} · 自动检查并后台下载新版本
      </p>

      <div className="flex items-center gap-2 mb-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => checkForUpdate()}
          disabled={checking || downloading || installing}
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", checking && "animate-spin")} />
          {checking ? "检查中…" : "检查更新"}
        </Button>
        {ready && (
          <Button variant="default" size="sm" onClick={() => installAndRelaunch()}>
            <RotateCw className="w-3.5 h-3.5 mr-1.5" />
            重启更新到 v{newVersion}
          </Button>
        )}
        {installing && (
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <RotateCw className="w-3.5 h-3.5 animate-spin" />
            正在安装并重启…
          </span>
        )}
      </div>

      {downloading && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>正在下载 v{newVersion}…</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {UPDATE_MODES.map((m) => {
          const active = mode === m.value;
          return (
            <div
              key={m.value}
              onClick={() => setMode(m.value)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md border cursor-pointer transition-colors select-none",
                active
                  ? "border-primary/60 bg-primary/5"
                  : "border-transparent bg-muted/40 hover:bg-muted/70"
              )}
            >
              <div
                className={cn(
                  "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                  active ? "border-primary" : "border-muted-foreground/40"
                )}
              >
                {active && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{m.label}</div>
                <div className="text-xs text-muted-foreground truncate">{m.description}</div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Settings() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { permissionMode, loadSettings, setPermissionMode } = useSettingsStore();
  const currentVersion = useUpdateStore((s) => s.currentVersion);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handlePermissionModeChange = async (mode: PermissionMode) => {
    try {
      await setPermissionMode(mode);
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const json = await invoke<string>("export_platforms");
      const filePath = await save({
        defaultPath: "jcode-platforms.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (filePath) {
        await invoke("write_file", { path: filePath, content: json });
        toast.success(`已导出到 ${filePath}`);
      }
    } catch (err) {
      toast.error(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    setExporting(false);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleMigrate = async () => {
    const ok = window.confirm(
      "确定要从系统 Keychain 迁移 API Key 到本地加密存储吗？\n\n" +
        "迁移过程中可能会弹出 Keychain 授权对话框（每个平台一次），" +
        "请在弹出时点击「始终允许」。\n\n" +
        "不会覆盖已存在的本地条目，旧 Keychain 数据保持不动，可重复执行。"
    );
    if (!ok) return;

    setMigrating(true);
    try {
      const result = await invoke<MigrationResult>("migrate_legacy_keychain", {
        overwrite: false,
      });
      const parts = [
        `成功迁移 ${result.migrated} 个`,
        result.skipped > 0 ? `跳过 ${result.skipped} 个（本地已存在）` : "",
        result.notFound > 0 ? `${result.notFound} 个平台未在旧 Keychain 中找到` : "",
      ].filter(Boolean);
      if (result.failures.length > 0) {
        const detail = result.failures.map(([n, e]) => `${n}: ${e}`).join("；");
        toast.error(`部分失败：${detail}`);
      } else {
        toast.success(parts.join("，") || "没有可迁移的数据");
      }
    } catch (err) {
      toast.error(`迁移失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    setMigrating(false);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const count = await invoke<number>("import_platforms", { json: text });
      toast.success(`已导入 ${count} 个平台配置`);
    } catch (err) {
      toast.error(`导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    setImporting(false);
    e.target.value = "";
  };

  return (
    <div className="p-6 space-y-5">
      <section>
        <SectionLabel>授权模式</SectionLabel>
        <p className="text-xs text-muted-foreground mb-3 -mt-1">
          启动 Claude Code 时传递的权限模式，对所有平台生效
        </p>
        <div className="grid grid-cols-1 gap-1.5">
          {PERMISSION_MODES.map((mode) => (
            <div
              key={mode.value}
              onClick={() => handlePermissionModeChange(mode.value)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md border cursor-pointer transition-colors select-none",
                permissionMode === mode.value
                  ? "border-primary/60 bg-primary/5"
                  : "border-transparent bg-muted/40 hover:bg-muted/70",
                mode.danger && permissionMode !== mode.value && "hover:border-destructive/30"
              )}
            >
              <div
                className={cn(
                  "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                  permissionMode === mode.value
                    ? "border-primary"
                    : "border-muted-foreground/40"
                )}
              >
                {permissionMode === mode.value && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </div>
              <div className="flex-1 min-w-0 flex items-baseline gap-2">
                <span className="text-sm font-medium">{mode.label}</span>
                <span className="text-xs text-muted-foreground font-mono shrink-0">
                  {mode.value}
                </span>
                <span className="text-xs text-muted-foreground truncate hidden sm:block">
                  — {mode.description}
                </span>
                {mode.danger && (
                  <span className="text-xs text-destructive/80 ml-auto shrink-0">⚠ 危险</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Divider />

      <NetworkProxySection />

      <Divider />

      <section>
        <SectionLabel>数据管理</SectionLabel>
        <p className="text-xs text-muted-foreground mb-3 -mt-1">
          导出或导入所有平台配置（含 API Key），方便迁移到其他电脑
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
            <Download className="w-3.5 h-3.5 mr-1.5" />
            {exporting ? "导出中…" : "导出配置"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleImportClick} disabled={importing}>
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {importing ? "导入中…" : "导入配置"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </section>

      <Divider />

      <section>
        <SectionLabel>密钥迁移</SectionLabel>
        <p className="text-xs text-muted-foreground mb-3 -mt-1">
          将旧版本保存在系统 Keychain 的 API Key 迁移到本地加密存储，之后启动不再触发 macOS 授权弹窗
        </p>
        <Button variant="outline" size="sm" onClick={handleMigrate} disabled={migrating}>
          <KeyRound className="w-3.5 h-3.5 mr-1.5" />
          {migrating ? "迁移中…" : "从 Keychain 迁移密钥"}
        </Button>
      </section>

      <Divider />

      <UpdateSection />

      <Divider />

      <section>
        <SectionLabel>关于</SectionLabel>
        <p className="text-xs text-muted-foreground">
          JCode{currentVersion ? ` v${currentVersion}` : ""} — Claude Code 多平台启动器
        </p>
      </section>
    </div>
  );
}
