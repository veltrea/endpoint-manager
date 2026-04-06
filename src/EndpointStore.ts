import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { IAIProviderNode, IStoreData, RoleMap } from './types.js';

const STORE_VERSION = 1;

export class EndpointStore {
  private _data: IStoreData;

  constructor(private readonly _path: string) {
    mkdirSync(dirname(_path), { recursive: true });
    this._data = this._load();
  }

  // ── 読み込み ────────────────────────────────────────────────
  private _load(): IStoreData {
    if (!existsSync(this._path)) {
      return { nodes: {}, roles: {}, version: STORE_VERSION };
    }
    try {
      const raw = readFileSync(this._path, 'utf-8');
      return JSON.parse(raw) as IStoreData;
    } catch {
      return { nodes: {}, roles: {}, version: STORE_VERSION };
    }
  }

  // ── 書き込み ────────────────────────────────────────────────
  private _save(): void {
    writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  // ── ノード操作 ──────────────────────────────────────────────
  getNode(id: string): IAIProviderNode | undefined {
    return this._data.nodes[id];
  }

  getAllNodes(): IAIProviderNode[] {
    return Object.values(this._data.nodes);
  }

  upsertNode(node: IAIProviderNode): void {
    this._data.nodes[node.id] = node;
    this._save();
  }

  removeNode(id: string): boolean {
    if (!(id in this._data.nodes)) return false;
    delete this._data.nodes[id];
    // ロールからも削除
    for (const [role, nodeId] of Object.entries(this._data.roles)) {
      if (nodeId === id) delete this._data.roles[role];
    }
    this._save();
    return true;
  }

  // ── ロール操作 ──────────────────────────────────────────────
  getRoles(): RoleMap {
    return { ...this._data.roles };
  }

  assignRole(role: string, nodeId: string): void {
    this._data.roles[role] = nodeId;
    this._save();
  }

  clearRole(role: string): void {
    delete this._data.roles[role];
    this._save();
  }
}
