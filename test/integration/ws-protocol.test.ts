import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import WebSocket from 'ws';
import { EndpointStore } from '../../src/EndpointStore.js';
import { EndpointManager } from '../../src/EndpointManager.js';
import { WsServer } from '../../src/WsServer.js';
import { IAIProviderNode, NodeHealthState, WsResponse, WsEvent } from '../../src/types.js';

// ── テスト用ユーティリティ ──────────────────────────────────
const TEST_PORT = 13797; // 本番と被らないポート

function makeTempStore(): EndpointStore {
  const dir = mkdtempSync(join(tmpdir(), 'em-ws-test-'));
  return new EndpointStore(join(dir, 'store.json'));
}

function makeNode(id: string, models: string[] = ['model-a']): IAIProviderNode {
  return {
    id,
    type:            'local',
    providerType:    'lmstudio',
    providerUrl:     `http://192.168.1.22:1234/v1`,
    availableModels: models,
    loadedModels:    [],
    healthStatus:    NodeHealthState.Online,
    lastSeenAt:      Date.now(),
  };
}

/** WS クライアントを接続し、初期同期メッセージを受け取ってから返す */
function connectClient(port: number): Promise<{ ws: WebSocket; initMessages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const initMessages: unknown[] = [];
    let count = 0;

    ws.on('message', (raw) => {
      initMessages.push(JSON.parse(raw.toString()));
      count++;
      // 接続時に scan_completed + roles_changed の 2 メッセージが届く
      if (count >= 2) resolve({ ws, initMessages });
    });

    ws.on('error', reject);
    // タイムアウト保険
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

/** コマンドを送信してレスポンスを受け取る */
function sendCommand(ws: WebSocket, cmd: Record<string, unknown>): Promise<WsResponse> {
  return new Promise((resolve, reject) => {
    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      // レスポンスは id フィールドを持つ
      if (msg.id === cmd.id) {
        ws.off('message', handler);
        resolve(msg as WsResponse);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(cmd));
    setTimeout(() => reject(new Error('response timeout')), 5000);
  });
}

/** 次のプッシュイベントを待つ */
function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 5000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === eventName) {
        ws.off('message', handler);
        resolve(msg as WsEvent);
      }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); reject(new Error(`timeout waiting for ${eventName}`)); }, timeoutMs);
  });
}

// ── テスト ──────────────────────────────────────────────────
describe('WS プロトコル統合テスト', () => {
  let store: EndpointStore;
  let manager: EndpointManager;
  let server: WsServer;

  before(() => {
    store = makeTempStore();
    // テスト用ノードを事前投入
    store.upsertNode(makeNode('node-1', ['model-a', 'model-b']));
    store.upsertNode(makeNode('node-2', ['model-c']));

    manager = new EndpointManager(store, { disableTimers: true });
    server = new WsServer(manager, TEST_PORT);
  });

  after(() => {
    server.close();
  });

  it('接続時に scan_completed + roles_changed が届く', async () => {
    const { ws, initMessages } = await connectClient(TEST_PORT);
    try {
      const events = initMessages.map((m: any) => m.event);
      assert.ok(events.includes('scan_completed'));
      assert.ok(events.includes('roles_changed'));
    } finally {
      ws.close();
    }
  });

  it('list コマンド → ノード一覧が返る', async () => {
    const { ws } = await connectClient(TEST_PORT);
    try {
      const res = await sendCommand(ws, { id: 'req-1', type: 'list' });
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data));
      assert.equal((res.data as any[]).length, 2);
    } finally {
      ws.close();
    }
  });

  it('resolve コマンド → モデル一致するノードが返る', async () => {
    const { ws } = await connectClient(TEST_PORT);
    try {
      const res = await sendCommand(ws, { id: 'req-2', type: 'resolve', modelId: 'model-a' });
      assert.equal(res.ok, true);
      assert.equal((res.data as any).id, 'node-1');
    } finally {
      ws.close();
    }
  });

  it('resolve 失敗（全 Offline）→ ok: false + error', async () => {
    // 一時的に全ノードを Offline にする
    manager.reportHealth('node-1', NodeHealthState.Offline);
    manager.reportHealth('node-2', NodeHealthState.Offline);

    const { ws } = await connectClient(TEST_PORT);
    try {
      const res = await sendCommand(ws, { id: 'req-3', type: 'resolve', modelId: 'model-a' });
      assert.equal(res.ok, false);
      assert.ok(res.error);
    } finally {
      // 復帰
      manager.reportHealth('node-1', NodeHealthState.Online);
      manager.reportHealth('node-2', NodeHealthState.Online);
      ws.close();
    }
  });

  it('get_roles コマンド → ロール割り当てが返る', async () => {
    const { ws } = await connectClient(TEST_PORT);
    try {
      const res = await sendCommand(ws, { id: 'req-4', type: 'get_roles' });
      assert.equal(res.ok, true);
      assert.equal(typeof res.data, 'object');
    } finally {
      ws.close();
    }
  });

  it('assign_role → roles_changed イベントが届く', async () => {
    const { ws } = await connectClient(TEST_PORT);
    try {
      const eventPromise = waitForEvent(ws, 'roles_changed');
      const res = await sendCommand(ws, { id: 'req-5', type: 'assign_role', role: 'coder', endpointId: 'node-1' });
      assert.equal(res.ok, true);

      const event = await eventPromise;
      assert.equal(event.event, 'roles_changed');
    } finally {
      ws.close();
    }
  });

  it('不正な JSON → クラッシュしない', async () => {
    const { ws } = await connectClient(TEST_PORT);
    try {
      ws.send('this is not json {{{');
      // サーバーがクラッシュしていないことを確認（正常なコマンドが通る）
      const res = await sendCommand(ws, { id: 'req-6', type: 'list' });
      assert.equal(res.ok, true);
    } finally {
      ws.close();
    }
  });

  it('未知のコマンド type → error レスポンス', async () => {
    const { ws } = await connectClient(TEST_PORT);
    try {
      const res = await sendCommand(ws, { id: 'req-7', type: 'unknown_command' });
      assert.equal(res.ok, false);
      assert.ok(res.error);
    } finally {
      ws.close();
    }
  });

  it('remove_endpoint → node_removed イベントが届く', async () => {
    // テスト用に一時ノードを追加
    store.upsertNode(makeNode('temp-node', ['model-x']));
    // manager にも反映させるために再構成（簡易的に直接操作）
    const tempMgr = manager as any;
    tempMgr._nodes.set('temp-node', makeNode('temp-node', ['model-x']));

    const { ws } = await connectClient(TEST_PORT);
    try {
      const eventPromise = waitForEvent(ws, 'node_removed');
      const res = await sendCommand(ws, { id: 'req-8', type: 'remove_endpoint', endpointId: 'temp-node' });
      assert.equal(res.ok, true);

      const event = await eventPromise;
      assert.equal(event.event, 'node_removed');
    } finally {
      ws.close();
    }
  });
});
