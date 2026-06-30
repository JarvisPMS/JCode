import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { X, Star, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageFooter } from "@/components/PageFooter";
import { usePlatformStore } from "@/store/platformStore";
import { PLATFORM_PRESETS, PRESET_MODELS, DEFAULT_CLAUDE_ID } from "@/lib/presets";
import { toast } from "@/components/Toast";

export default function PlatformEdit() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { platforms, loadPlatforms, addPlatform, updatePlatform } =
    usePlatformStore();

  const isEdit = !!id;
  const existing = isEdit ? platforms.find((p) => p.id === id) : null;

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("default.svg");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [anthropicCompatViaProxy, setAnthropicCompatViaProxy] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [showModelSuggestions, setShowModelSuggestions] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const [defaultWorkDir, setDefaultWorkDir] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (platforms.length === 0) loadPlatforms();
  }, [platforms.length, loadPlatforms]);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setIcon(existing.icon);
      setBaseUrl(existing.baseUrl);
      setOpenaiBaseUrl(existing.openaiBaseUrl ?? "");
      setAnthropicCompatViaProxy(existing.anthropicCompatViaProxy ?? false);
      setDefaultModel(existing.defaultModel);
      const models = existing.models ? existing.models.split(",").filter(Boolean) : [];
      setModelList(models);
      setDefaultWorkDir(existing.defaultWorkDir);
      setConfigDir(existing.configDir);
      setExtraArgs(existing.extraArgs);
      setEnabled(existing.enabled !== false);
    }
  }, [existing]);

  const applyPreset = (preset: (typeof PLATFORM_PRESETS)[number]) => {
    setName(preset.name);
    setIcon(preset.icon);
    setBaseUrl(preset.baseUrl);
    setOpenaiBaseUrl(preset.openaiBaseUrl ?? "");
    setAnthropicCompatViaProxy(preset.anthropicCompatViaProxy ?? false);
    setDefaultModel(preset.defaultModel);
    const presetModels = PRESET_MODELS[preset.name] ?? [];
    setModelList(presetModels);
    setConfigDir(preset.configDir);
    setExtraArgs(preset.extraArgs);
    setDefaultWorkDir(preset.defaultWorkDir);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const config = {
      name: name.trim(),
      icon,
      baseUrl: baseUrl.trim(),
      openaiBaseUrl: openaiBaseUrl.trim(),
      // 有原生 Anthropic 端点时兼容开关无意义，强制 false
      anthropicCompatViaProxy: baseUrl.trim() ? false : anthropicCompatViaProxy,
      defaultModel: defaultModel.trim(),
      models: modelList.join(","),
      defaultWorkDir: defaultWorkDir.trim(),
      configDir: configDir.trim(),
      extraArgs: extraArgs.trim(),
      enabled,
    };
    try {
      if (isEdit && id) {
        await updatePlatform(id, config, apiKey.trim());
        toast.success("平台已更新");
      } else {
        await addPlatform(config, apiKey.trim());
        toast.success("平台已添加");
      }
      navigate("/");
    } catch (err) {
      toast.error(
        `保存失败: ${err instanceof Error ? err.message : String(err)}`
      );
      setSaving(false);
    }
  };

  return (
    <div className="p-6">
      <div className="max-w-lg mx-auto">
        {/* 预设快选 — 仅添加模式 */}
        {!isEdit && (
          <div className="grid grid-cols-4 gap-3 mb-8">
            {PLATFORM_PRESETS.filter((p) => p.fixedId !== DEFAULT_CLAUDE_ID).map((preset, i) => (
              <button
                key={i}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`flex flex-col items-center gap-1.5 p-2.5 rounded-lg border transition-colors ${
                  name === preset.name
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                }`}
              >
                <div className="w-10 h-10 rounded-md overflow-hidden">
                  <img
                    src={`/platform-icons/${preset.icon}`}
                    alt={preset.name}
                    className="w-full h-full object-contain"
                  />
                </div>
                <span className="text-[11px] leading-tight text-center truncate w-full">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        )}

        <form id="platform-form" onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">平台名称 *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：Anthropic"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiKey">
              API Key {isEdit ? "(留空表示不更新)" : "*"}
            </Label>
            <Input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              required={!isEdit}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="baseUrl">Base URL（Anthropic 协议）</Label>
            <Input
              id="baseUrl"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
            />
            <p className="text-xs text-muted-foreground">
              原生 Anthropic 端点，填了即直连（最快）。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="openaiBaseUrl">OpenAI 兼容端点（可选）</Label>
            <Input
              id="openaiBaseUrl"
              value={openaiBaseUrl}
              onChange={(e) => setOpenaiBaseUrl(e.target.value)}
              placeholder="https://api.xxx.com/v1"
            />
            <p className="text-xs text-muted-foreground">
              填到 <code>/v1</code> 为止，代理会自动拼 <code>/chat/completions</code>。模型名填 OpenAI 那边的真实名（如 gpt-4o、deepseek-chat）。
            </p>
          </div>

          {/* 兼容开关：仅当没有原生 Anthropic 端点、且填了 OpenAI 端点时有意义 */}
          <div
            className={`flex items-center justify-between rounded-md border border-input px-3 py-2.5 ${
              baseUrl.trim() ? "opacity-50" : ""
            }`}
          >
            <div className="min-w-0">
              <Label className="cursor-default">用 Claude Code 启动（经本地代理转协议）</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {baseUrl.trim()
                  ? "已有原生 Anthropic 端点，将直连，无需此开关。"
                  : "开启后该平台经本地代理把 Anthropic 请求转成 OpenAI 协议。"}
              </p>
            </div>
            <Switch
              checked={baseUrl.trim() ? false : anthropicCompatViaProxy}
              onCheckedChange={setAnthropicCompatViaProxy}
              disabled={!!baseUrl.trim() || !openaiBaseUrl.trim()}
            />
          </div>

          <div className="space-y-2">
            <Label>模型管理</Label>
            <div className="flex flex-wrap gap-1.5 min-h-[36px] p-2 rounded-md border border-input bg-background">
              {modelList.map((model) => (
                <span
                  key={model}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs cursor-pointer transition-colors ${
                    model === defaultModel
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  }`}
                  onClick={() => setDefaultModel(model)}
                  title={model === defaultModel ? "当前默认模型" : "点击设为默认"}
                >
                  {model === defaultModel && <Star className="w-3 h-3" />}
                  {model}
                  <button
                    type="button"
                    className="ml-0.5 hover:text-destructive"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      const next = modelList.filter((m) => m !== model);
                      setModelList(next);
                      if (defaultModel === model) {
                        setDefaultModel(next[0] ?? "");
                      }
                    }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <div className="relative flex-1 min-w-[120px]">
                <input
                  ref={modelInputRef}
                  type="text"
                  value={modelInput}
                  onChange={(e) => {
                    setModelInput(e.target.value);
                    setShowModelSuggestions(true);
                  }}
                  onFocus={() => setShowModelSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowModelSuggestions(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      const val = modelInput.trim().replace(/,$/, "");
                      if (val && !modelList.includes(val)) {
                        const next = [...modelList, val];
                        setModelList(next);
                        if (!defaultModel) setDefaultModel(val);
                      }
                      setModelInput("");
                    }
                    if (e.key === "Backspace" && !modelInput && modelList.length > 0) {
                      const removed = modelList[modelList.length - 1];
                      const next = modelList.slice(0, -1);
                      setModelList(next);
                      if (defaultModel === removed) {
                        setDefaultModel(next[0] ?? "");
                      }
                    }
                  }}
                  placeholder={modelList.length === 0 ? "输入模型名，回车添加" : "继续添加..."}
                  className="w-full bg-transparent outline-none text-sm py-0.5"
                />
                {showModelSuggestions && name && (() => {
                  const suggestions = (PRESET_MODELS[name] ?? []).filter(
                    (m) => !modelList.includes(m) && m.toLowerCase().includes(modelInput.toLowerCase())
                  );
                  if (suggestions.length === 0) return null;
                  return (
                    <div className="absolute left-0 top-full mt-1 w-full bg-popover border border-border rounded-md shadow-md z-10 max-h-40 overflow-y-auto">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                          onMouseDown={(ev) => {
                            ev.preventDefault();
                            const next = [...modelList, s];
                            setModelList(next);
                            if (!defaultModel) setDefaultModel(s);
                            setModelInput("");
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              点击标签设为默认模型（⭐ 标记），按 Backspace 删除最后一个
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="configDir">配置目录 *</Label>
            <Input
              id="configDir"
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              placeholder="例：ali → ~/.jcode/ali"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              填写简称即可（如 ali），会自动存到 ~/.jcode/ali。也支持绝对路径。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultWorkDir">默认工作目录</Label>
            <Input
              id="defaultWorkDir"
              value={defaultWorkDir}
              onChange={(e) => setDefaultWorkDir(e.target.value)}
              placeholder="留空则每次启动时选择"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="extraArgs">额外启动参数</Label>
            <Input
              id="extraArgs"
              value={extraArgs}
              onChange={(e) => setExtraArgs(e.target.value)}
              placeholder="--verbose"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-input px-3 py-2.5">
            <div className="min-w-0">
              <Label className="cursor-default">在首屏显示</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                关闭后此平台仅在「平台列表」中可见
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

        </form>
      </div>

      <PageFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate("/platform/list")}
        >
          <List className="w-4 h-4 mr-1" />
          平台列表
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate("/")}
          >
            取消
          </Button>
          <Button type="submit" form="platform-form" size="sm" disabled={saving}>
            {saving ? "保存中..." : isEdit ? "保存" : "添加"}
          </Button>
        </div>
      </PageFooter>
    </div>
  );
}
