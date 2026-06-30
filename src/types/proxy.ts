export interface ProxyMapping {
  id: string;
  sourceModel: string;
  targetPlatformId: string;
  targetModel: string;
}

export interface ProxyConfig {
  port: number;
  mappings: ProxyMapping[];
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
}
