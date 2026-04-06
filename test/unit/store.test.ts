import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { EndpointStore } from '../../src/EndpointStore.js';
import { IAIProviderNode, NodeHealthState } from '../../src/types.js';

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'em-store-test-'));
  return join(dir, 'store.json');
}

function makeNode(id: string): IAIProviderNode {
  return {
    id,
    type:            'local',
    providerType:    'lmstudio',
    providerUrl:     `http://192.168.1.22:1234/v1`,
    availableModels: ['model-a'],
    loadedModels:    [],
    healthStatus:    NodeHealthState.Online,
    lastSeenAt:      Date.now(),
  };
}

describe('EndpointStore', () => {
  let path: string;
  let store: EndpointStore;

  beforeEach(() => {
    path = makeTempPath();
    store = new EndpointStore(path);
  });

  it('新規作成 → 空の状態で初期化', () => {
    assert.deepEqual(store.getAllNodes(), []);
    assert.deepEqual(store.getRoles(), {});
  });

  it('upsertNode → ファイルに書き込まれる', () => {
    const node = makeNode('node-1');
    store.upsertNode(node);

    assert.equal(store.getNode('node-1')?.id, 'node-1');
    // ファイルにも永続化されていることを確認
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.ok(raw.nodes['node-1']);
  });

  it('removeNode → ノード削除', () => {
    store.upsertNode(makeNode('node-1'));
    const removed = store.removeNode('node-1');
    assert.equal(removed, true);
    assert.equal(store.getNode('node-1'), undefined);
  });

  it('removeNode → 存在しないノード → false', () => {
    const removed = store.removeNode('nonexistent');
    assert.equal(removed, false);
  });

  it('removeNode → 関連ロールもカスケード削除', () => {
    store.upsertNode(makeNode('node-1'));
    store.assignRole('coder', 'node-1');
    store.assignRole('reviewer', 'node-1');
    assert.equal(store.getRoles()['coder'], 'node-1');

    store.removeNode('node-1');
    const roles = store.getRoles();
    assert.equal(roles['coder'], undefined);
    assert.equal(roles['reviewer'], undefined);
  });

  it('assignRole / clearRole → ロールの追加・削除', () => {
    store.assignRole('coder', 'node-1');
    assert.equal(store.getRoles()['coder'], 'node-1');

    store.clearRole('coder');
    assert.equal(store.getRoles()['coder'], undefined);
  });

  it('壊れた JSON → デフォルト状態にフォールバック', () => {
    writeFileSync(path, '{ broken json !!!', 'utf-8');
    const store2 = new EndpointStore(path);
    assert.deepEqual(store2.getAllNodes(), []);
    assert.deepEqual(store2.getRoles(), {});
  });

  it('ディレクトリが存在しない → 自動作成', () => {
    const deepPath = join(tmpdir(), `em-deep-${Date.now()}`, 'sub', 'store.json');
    const store2 = new EndpointStore(deepPath);
    store2.upsertNode(makeNode('node-1'));
    assert.equal(store2.getNode('node-1')?.id, 'node-1');
  });

  it('ファイルから復元できる（永続化の検証）', () => {
    store.upsertNode(makeNode('node-1'));
    store.assignRole('coder', 'node-1');

    // 同じパスで新しいインスタンスを作る → 復元される
    const store2 = new EndpointStore(path);
    assert.equal(store2.getNode('node-1')?.id, 'node-1');
    assert.equal(store2.getRoles()['coder'], 'node-1');
  });
});
