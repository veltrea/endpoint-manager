import { EventEmitter } from 'node:events';
import { IAIProviderNode, NodeHealthState, RoleMap, WsEvent } from './types.js';
import { EndpointStore } from './EndpointStore.js';
import { probeEndpoint, buildNode, scanNetwork } from './NetworkScanner.js';

// 回復チェック間隔（Offline / Unreachable ノードを再プローブ）
const HEALTH_RECOVERY_INTERVAL_MS  = 60_000;
// ロード済みモデルの定期更新間隔
const MODEL_POLL_INTERVAL_MS        = 30_000;

export declare interface EndpointManager {
  on(event: 'push', listener: (msg: WsEvent) => void): this;
  emit(event: 'push', msg: WsEvent): boolean;
}

export interface EndpointManagerOptions {
  scanner?: typeof scanNetwork;
  prober?: typeof probeEndpoint;
  /** テスト用: タイマーを起動しない */
  disableTimers?: boolean;
}

export class EndpointManager extends EventEmitter {
  // メモリが正。ストアは永続化専用
  private _nodes = new Map<string, IAIProviderNode>();
  private _scanning = false;
  private readonly _scanner: typeof scanNetwork;
  private readonly _prober: typeof probeEndpoint;

  constructor(
    private readonly _store: EndpointStore,
    opts?: EndpointManagerOptions,
  ) {
    super();
    this._scanner = opts?.scanner ?? scanNetwork;
    this._prober  = opts?.prober  ?? probeEndpoint;

    // 起動時にストアから復元
    for (const node of _store.getAllNodes()) {
      this._nodes.set(node.id, node);
    }
    if (!opts?.disableTimers) {
      this._startHealthTimer();
      this._startModelPollTimer();
    }
  }

  // ════════════════════════════════════════════════════════════
  // 参照
  // ════════════════════════════════════════════════════════════

  getNode(id: string): IAIProviderNode | undefined {
    return this._nodes.get(id);
  }

  getAllNodes(): IAIProviderNode[] {
    return [...this._nodes.values()];
  }

  getRoles(): RoleMap {
    return this._store.getRoles();
  }

  // ロール優先でモデルを提供できるノードを解決
  resolve(modelId: string, role?: string): IAIProviderNode | undefined {
    const roles = this._store.getRoles();
    const online = (n: IAIProviderNode) => n.healthStatus === NodeHealthState.Online;
    const hasModel = (n: IAIProviderNode) =>
      n.availableModels.some((m) => m === modelId || m.endsWith(`/${modelId}`));

    // 1. ロール指定があれば優先
    if (role && roles[role]) {
      const node = this._nodes.get(roles[role]);
      if (node && online(node) && hasModel(node)) return node;
    }

    // 2. モデルが一致するオンラインノードを探す
    for (const node of this._nodes.values()) {
      if (online(node) && hasModel(node)) return node;
    }

    // 3. モデル名を問わずオンラインのノードを返す（フォールバック）
    for (const node of this._nodes.values()) {
      if (online(node)) return node;
    }

    return undefined;
  }

  // ════════════════════════════════════════════════════════════
  // 変更操作
  // ════════════════════════════════════════════════════════════

  async addEndpoint(url: string, label?: string): Promise<IAIProviderNode> {
    const probe = await this._prober(url.endsWith('/v1') ? url : `${url.replace(/\/$/, '')}/v1`);
    const node  = buildNode(probe);
    if (label) node.label = label;
    if (!probe.reachable) node.healthStatus = NodeHealthState.Unreachable;

    this._upsert(node);
    return node;
  }

  removeEndpoint(id: string): boolean {
    if (!this._nodes.has(id)) return false;
    this._nodes.delete(id);
    this._store.removeNode(id);
    this._push({ event: 'node_removed', data: { nodeId: id } });
    return true;
  }

  assignRole(role: string, nodeId: string): void {
    this._store.assignRole(role, nodeId);
    this._push({ event: 'roles_changed', data: this._store.getRoles() });
  }

  unassignRole(role: string): void {
    this._store.clearRole(role);
    this._push({ event: 'roles_changed', data: this._store.getRoles() });
  }

  // ════════════════════════════════════════════════════════════
  // 双方向同期（クライアントからの報告を受け取る）
  // ════════════════════════════════════════════════════════════

  reportHealth(endpointId: string, state: NodeHealthState): void {
    const node = this._nodes.get(endpointId);
    if (!node) return;
    this._updateHealth(node, state);
  }

  reportModelLoaded(endpointId: string, modelId: string): void {
    const node = this._nodes.get(endpointId);
    if (!node) return;
    if (!node.loadedModels.includes(modelId)) {
      node.loadedModels = [...node.loadedModels, modelId];
      node.lastSeenAt = Date.now();
      this._upsert(node);
      this._push({ event: 'models_updated', data: { nodeId: node.id, availableModels: node.availableModels, loadedModels: node.loadedModels } });
    }
  }

  reportModels(endpointId: string, availableModels: string[], loadedModels: string[]): void {
    const node = this._nodes.get(endpointId);
    if (!node) return;
    node.availableModels = availableModels;
    node.loadedModels    = loadedModels;
    node.lastSeenAt      = Date.now();
    this._upsert(node);
    this._push({ event: 'models_updated', data: { nodeId: node.id, availableModels, loadedModels } });
  }

  // ════════════════════════════════════════════════════════════
  // スキャン
  // ════════════════════════════════════════════════════════════

  async scan(): Promise<IAIProviderNode[]> {
    if (this._scanning) return this.getAllNodes();
    this._scanning = true;
    this._push({ event: 'scan_started' });

    try {
      const found = await this._scanner((node) => {
        // 発見するたびにリアルタイムで通知
        const existing = this._nodes.get(node.id);
        if (!existing) {
          this._upsert(node);
          this._push({ event: 'node_discovered', data: node });
        } else {
          // 再スキャンで生きているのが確認できたらヘルスを更新
          this._updateHealth(existing, NodeHealthState.Online);
          // モデル情報も更新
          existing.availableModels = node.availableModels;
          existing.loadedModels    = node.loadedModels;
          existing.lastSeenAt      = Date.now();
          this._upsert(existing);
        }
      });

      this._push({ event: 'scan_completed', data: { found: found.length, nodes: found } });
      return found;
    } finally {
      this._scanning = false;
    }
  }

  async probeOne(endpointId: string): Promise<IAIProviderNode | undefined> {
    const node = this._nodes.get(endpointId);
    if (!node) return undefined;

    const probe = await this._prober(node.providerUrl);
    const state = probe.reachable ? NodeHealthState.Online : NodeHealthState.Unreachable;
    this._updateHealth(node, state);

    if (probe.reachable) {
      node.availableModels = probe.availableModels;
      node.loadedModels    = probe.loadedModels;
      node.lastSeenAt      = Date.now();
      this._upsert(node);
    }
    return node;
  }

  // ════════════════════════════════════════════════════════════
  // 内部ユーティリティ
  // ════════════════════════════════════════════════════════════

  private _upsert(node: IAIProviderNode): void {
    this._nodes.set(node.id, node);
    this._store.upsertNode(node);
  }

  private _updateHealth(node: IAIProviderNode, state: NodeHealthState): void {
    if (node.healthStatus === state) return;
    node.healthStatus = state;
    node.lastSeenAt   = Date.now();
    this._upsert(node);
    this._push({ event: 'node_state_changed', data: { nodeId: node.id, state } });
  }

  private _push(msg: WsEvent): void {
    this.emit('push', msg);
  }

  // ── 定期ヘルスチェック ──────────────────────────────────────
  private _startHealthTimer(): void {
    setInterval(async () => {
      for (const node of this._nodes.values()) {
        if (
          node.healthStatus === NodeHealthState.Offline ||
          node.healthStatus === NodeHealthState.Unreachable
        ) {
          await this.probeOne(node.id);
        }
      }
    }, HEALTH_RECOVERY_INTERVAL_MS);
  }

  // ── 定期モデル更新（オンラインノードのみ）───────────────────
  private _startModelPollTimer(): void {
    setInterval(async () => {
      for (const node of this._nodes.values()) {
        if (node.healthStatus === NodeHealthState.Online) {
          await this.probeOne(node.id);
        }
      }
    }, MODEL_POLL_INTERVAL_MS);
  }
}
