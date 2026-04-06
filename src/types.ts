// ── ノードの健康状態 ──────────────────────────────────────────
export enum NodeHealthState {
  Online       = 'Online',
  Offline      = 'Offline',
  RateLimited  = 'RateLimited',
  Unreachable  = 'Unreachable',
}

// ── プロバイダー種別 ──────────────────────────────────────────
export type ProviderType =
  | 'lmstudio'
  | 'local_lmstudio'
  | 'remote_lmstudio'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'custom';

// ── AIプロバイダーノード ─────────────────────────────────────
export interface IAIProviderNode {
  id:            string;          // "local-http://192.168.1.22:1234/v1" など
  type:          'cloud' | 'local';
  providerType:  ProviderType;
  providerUrl:   string;          // "http://192.168.1.22:1234/v1"
  label?:        string;          // 表示名（任意）
  availableModels: string[];      // /v1/models で取得したモデル一覧
  loadedModels:    string[];      // /api/v0/models で取得した VRAM 読み込み済みモデル
  healthStatus:    NodeHealthState;
  lastSeenAt:      number;        // Unix ms
}

// ── ロール割り当て ────────────────────────────────────────────
export type RoleMap = Record<string, string>; // role → nodeId

// ── ストア永続化データ ────────────────────────────────────────
export interface IStoreData {
  nodes:   Record<string, IAIProviderNode>;
  roles:   RoleMap;
  version: number;
}

// ════════════════════════════════════════════════════════════════
// WebSocket プロトコル
// ════════════════════════════════════════════════════════════════

// ── クライアント → サーバー（コマンド）───────────────────────
export type WsCommand =
  // 探索・参照
  | { id: string; type: 'scan' }
  | { id: string; type: 'list' }
  | { id: string; type: 'resolve';           modelId: string; role?: string }
  | { id: string; type: 'get_models';        endpointId: string }
  | { id: string; type: 'probe';             endpointId: string }
  // 管理
  | { id: string; type: 'add_endpoint';      url: string; label?: string }
  | { id: string; type: 'remove_endpoint';   endpointId: string }
  | { id: string; type: 'get_roles' }
  | { id: string; type: 'assign_role';       role: string; endpointId: string }
  | { id: string; type: 'unassign_role';     role: string }
  // 双方向同期（クライアントが観測した状態をサービスに通知）
  | { id: string; type: 'report_health';     endpointId: string; state: NodeHealthState }
  | { id: string; type: 'report_model_loaded'; endpointId: string; modelId: string }
  | { id: string; type: 'report_models';     endpointId: string; availableModels: string[]; loadedModels: string[] };

// ── サーバー → クライアント（レスポンス）────────────────────
export interface WsResponse {
  id:    string;
  ok:    boolean;
  data?: unknown;
  error?: string;
}

// ── サーバー → クライアント（プッシュイベント）──────────────
export type WsEvent =
  | { event: 'node_discovered';     data: IAIProviderNode }
  | { event: 'node_state_changed';  data: { nodeId: string; state: NodeHealthState } }
  | { event: 'models_updated';      data: { nodeId: string; availableModels: string[]; loadedModels: string[] } }
  | { event: 'scan_started' }
  | { event: 'scan_completed';      data: { found: number; nodes: IAIProviderNode[] } }
  | { event: 'node_removed';        data: { nodeId: string } }
  | { event: 'roles_changed';       data: RoleMap };
