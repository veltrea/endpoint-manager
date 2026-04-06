import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { EndpointStore } from '../../src/EndpointStore.js';
import { EndpointManager } from '../../src/EndpointManager.js';
import { IAIProviderNode, NodeHealthState } from '../../src/types.js';

// ── テスト用ヘルパー ────────────────────────────────────────
function makeTempStore(): EndpointStore {
  const dir = mkdtempSync(join(tmpdir(), 'em-test-'));
  return new EndpointStore(join(dir, 'store.json'));
}

function makeNode(overrides: Partial<IAIProviderNode> = {}): IAIProviderNode {
  return {
    id:              overrides.id ?? 'node-1',
    type:            overrides.type ?? 'local',
    providerType:    overrides.providerType ?? 'lmstudio',
    providerUrl:     overrides.providerUrl ?? 'http://192.168.1.22:1234/v1',
    availableModels: overrides.availableModels ?? ['model-a', 'model-b'],
    loadedModels:    overrides.loadedModels ?? ['model-a'],
    healthStatus:    overrides.healthStatus ?? NodeHealthState.Online,
    lastSeenAt:      overrides.lastSeenAt ?? Date.now(),
    ...(overrides.label ? { label: overrides.label } : {}),
  };
}

function makeManager(store: EndpointStore, nodes: IAIProviderNode[] = []): EndpointManager {
  for (const n of nodes) store.upsertNode(n);
  return new EndpointManager(store, { disableTimers: true });
}

// ── テスト本体 ──────────────────────────────────────────────
describe('EndpointManager.resolve()', () => {
  let store: EndpointStore;

  beforeEach(() => {
    store = makeTempStore();
  });

  it('モデル一致する Online ノードを返す', () => {
    const node = makeNode();
    const mgr = makeManager(store, [node]);
    const result = mgr.resolve('model-a');
    assert.equal(result?.id, 'node-1');
  });

  it('モデル部分一致（末尾一致）で解決できる', () => {
    const node = makeNode({
      availableModels: ['publisher/model-x'],
    });
    const mgr = makeManager(store, [node]);
    const result = mgr.resolve('model-x');
    assert.equal(result?.id, 'node-1');
  });

  it('ロール指定あり + Online + モデル一致 → そのノードを返す', () => {
    const node1 = makeNode({ id: 'node-1', availableModels: ['model-a'] });
    const node2 = makeNode({ id: 'node-2', availableModels: ['model-a'] });
    store.upsertNode(node1);
    store.upsertNode(node2);
    store.assignRole('coder', 'node-2');
    const mgr = new EndpointManager(store, { disableTimers: true });

    const result = mgr.resolve('model-a', 'coder');
    assert.equal(result?.id, 'node-2');
  });

  it('ロール指定あり + ノード Offline → フォールバック', () => {
    const node1 = makeNode({ id: 'node-1', healthStatus: NodeHealthState.Offline, availableModels: ['model-a'] });
    const node2 = makeNode({ id: 'node-2', healthStatus: NodeHealthState.Online, availableModels: ['model-a'] });
    store.upsertNode(node1);
    store.upsertNode(node2);
    store.assignRole('coder', 'node-1');
    const mgr = new EndpointManager(store, { disableTimers: true });

    const result = mgr.resolve('model-a', 'coder');
    // ロール指定ノードが Offline なので node-2 にフォールバック
    assert.equal(result?.id, 'node-2');
  });

  it('ロール指定なし + 複数ノードがモデル一致 → 最初の Online ノード', () => {
    const node1 = makeNode({ id: 'node-1', availableModels: ['model-a'] });
    const node2 = makeNode({ id: 'node-2', availableModels: ['model-a'] });
    const mgr = makeManager(store, [node1, node2]);

    const result = mgr.resolve('model-a');
    assert.equal(result?.id, 'node-1');
  });

  it('モデル不一致 → モデル不問で Online ノードをフォールバック', () => {
    const node = makeNode({ availableModels: ['model-a'] });
    const mgr = makeManager(store, [node]);

    const result = mgr.resolve('nonexistent-model');
    assert.equal(result?.id, 'node-1');
  });

  it('全ノード Offline → undefined', () => {
    const node1 = makeNode({ id: 'node-1', healthStatus: NodeHealthState.Offline });
    const node2 = makeNode({ id: 'node-2', healthStatus: NodeHealthState.Unreachable });
    const mgr = makeManager(store, [node1, node2]);

    const result = mgr.resolve('model-a');
    assert.equal(result, undefined);
  });

  it('ノード 0 件 → undefined', () => {
    const mgr = makeManager(store);
    const result = mgr.resolve('model-a');
    assert.equal(result, undefined);
  });

  it('ロール指定あり + モデル不一致 → フォールバック（モデル不問）', () => {
    const node = makeNode({ id: 'node-1', availableModels: ['model-a'] });
    store.upsertNode(node);
    store.assignRole('coder', 'node-1');
    const mgr = new EndpointManager(store, { disableTimers: true });

    // ロールのノードにモデルが無い → フォールバックでモデル不問の Online ノード
    const result = mgr.resolve('nonexistent', 'coder');
    assert.equal(result?.id, 'node-1');
  });
});
