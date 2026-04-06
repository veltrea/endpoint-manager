# Endpoint Manager — クライアント統合ガイド

> **対象読者**: Endpoint Manager に WebSocket で接続するクライアント（VS Code Fork / Rust エディタ等）を実装する AI・開発者

---

## 概要

Endpoint Manager は、ローカルネットワーク上の AI 推論エンドポイント（主に LM Studio）を自動検出・管理・監視するバックグラウンドサービスです。WebSocket で接続するだけで、以下の機能をクライアントから利用できます。

- ネットワーク上の AI 推論サーバーの自動発見
- ノードの死活監視（自動回復検出付き）
- ロール（`planner` / `coder` / `fast` 等）に基づくエンドポイント解決
- モデル情報のリアルタイム同期

**クライアントは AI の推論ロジックだけに集中できます。接続先の管理はすべて Endpoint Manager が担います。**

---

## 接続

### WebSocket エンドポイント

```
ws://127.0.0.1:3797
```

ポートは環境変数 `EM_WS_PORT` で変更可能（デフォルト: `3797`）。

### 接続後の動作

接続直後にサーバーから2つのイベントが自動送信されます（初期同期）:

1. `scan_completed` — 現在管理中のノード一覧
2. `roles_changed` — 現在のロール割り当て

クライアントはこの2つのイベントを受け取って初期状態を構築します。追加のリクエストは不要です。

---

## メッセージフォーマット

すべてのメッセージは JSON 文字列です。3種類あります:

### 1. コマンド（クライアント → サーバー）

```typescript
{ id: string; type: string; ...パラメータ }
```

`id` はクライアントが自由に生成する一意な文字列です。レスポンスの対応付けに使います。

### 2. レスポンス（サーバー → クライアント）

`id` フィールドを持つメッセージはコマンドへの返答です。

```typescript
// 成功
{ id: string; ok: true;  data: unknown }
// 失敗
{ id: string; ok: false; error: string }
```

### 3. プッシュイベント（サーバー → クライアント）

`id` フィールドを持たないメッセージはサーバーからのプッシュ通知です。

```typescript
{ event: string; data?: unknown }
```

---

## データ型

### `IAIProviderNode` — ノード情報

```typescript
interface IAIProviderNode {
  id:              string;           // 例: "local-http://192.168.1.22:1234/v1"
  type:            'cloud' | 'local';
  providerType:    ProviderType;
  providerUrl:     string;           // 例: "http://192.168.1.22:1234/v1"
  label?:          string;
  availableModels: string[];         // /v1/models で取得したモデル一覧
  loadedModels:    string[];         // VRAM に読み込み済みのモデル
  healthStatus:    NodeHealthState;
  lastSeenAt:      number;           // Unix ミリ秒
}
```

### `NodeHealthState`

| 値 | 意味 |
|---|---|
| `Online` | 応答あり・正常 |
| `Offline` | 接続拒否 |
| `RateLimited` | HTTP 429 |
| `Unreachable` | タイムアウト・到達不能 |

### `ProviderType`

```typescript
type ProviderType =
  | 'lmstudio' | 'local_lmstudio' | 'remote_lmstudio'
  | 'ollama' | 'openai' | 'anthropic' | 'google'
  | 'openrouter' | 'custom';
```

### `RoleMap`

```typescript
type RoleMap = Record<string, string>; // ロール名 → ノードID
```

---

## コマンドリファレンス

### `resolve` — エンドポイント解決（最重要）

**エディタが AI 推論を行いたいときに呼ぶコマンドです。**

```json
{
  "id": "1",
  "type": "resolve",
  "modelId": "llama-3-8b",
  "role": "coder"
}
```

- `modelId`: 使いたいモデルID。空文字 `""` でモデル不問
- `role`: 省略可。ロールを指定するとそのノードを優先

**レスポンス**: `IAIProviderNode` 全体を返す。`providerUrl` が推論 API のベース URL。

**解決ロジック（優先順位）**:
1. `role` 指定あり → そのロールのノードが Online かつモデルを持つ → 返す
2. 指定モデルを持つ Online ノードを探す
3. モデル不問で Online ノードを返す（フォールバック）
4. 見つからない → `{ ok: false, error: "..." }`

### `list` — ノード一覧取得

```json
{ "id": "2", "type": "list" }
```

レスポンス: `IAIProviderNode[]`

### `scan` — ネットワーク再スキャン

```json
{ "id": "3", "type": "scan" }
```

非同期で開始。結果は `scan_started` → `node_discovered` × N → `scan_completed` イベントで届く。

### `probe` — 単一ノードの状態更新

```json
{ "id": "4", "type": "probe", "endpointId": "local-http://192.168.1.22:1234/v1" }
```

レスポンス: 更新済みの `IAIProviderNode`

### `get_models` — ノードのモデル一覧

```json
{ "id": "5", "type": "get_models", "endpointId": "local-http://127.0.0.1:1234/v1" }
```

レスポンス: `{ availableModels: string[], loadedModels: string[] }`

### `get_roles` — ロール割り当て取得

```json
{ "id": "6", "type": "get_roles" }
```

レスポンス: `RoleMap`

### `add_endpoint` — エンドポイント手動追加

```json
{ "id": "7", "type": "add_endpoint", "url": "http://192.168.1.50:1234/v1", "label": "GPU Server" }
```

### `remove_endpoint` — エンドポイント削除

```json
{ "id": "8", "type": "remove_endpoint", "endpointId": "local-http://192.168.1.50:1234/v1" }
```

### `assign_role` / `unassign_role` — ロール管理

```json
{ "id": "9", "type": "assign_role", "role": "coder", "endpointId": "local-http://192.168.1.22:1234/v1" }
{ "id": "10", "type": "unassign_role", "role": "coder" }
```

### 双方向同期コマンド

クライアントが推論中に観測した情報をサービスに報告し、全クライアント間で共有できます。

```json
{ "id": "11", "type": "report_health", "endpointId": "...", "state": "Offline" }
{ "id": "12", "type": "report_model_loaded", "endpointId": "...", "modelId": "llama-3-70b" }
{ "id": "13", "type": "report_models", "endpointId": "...", "availableModels": [...], "loadedModels": [...] }
```

---

## プッシュイベント一覧

| イベント | data | 発火タイミング |
|---|---|---|
| `scan_started` | なし | スキャン開始 |
| `scan_completed` | `{ found: number, nodes: IAIProviderNode[] }` | スキャン完了 / 接続時の初期同期 |
| `node_discovered` | `IAIProviderNode` | 新しいノード発見 |
| `node_state_changed` | `{ nodeId: string, state: NodeHealthState }` | ヘルス状態変化 |
| `models_updated` | `{ nodeId: string, availableModels: string[], loadedModels: string[] }` | モデル情報更新 |
| `node_removed` | `{ nodeId: string }` | ノード削除 |
| `roles_changed` | `RoleMap` | ロール割り当て変更 / 接続時の初期同期 |

---

## 実装例（TypeScript）

### 最小限のクライアント

```typescript
import WebSocket from 'ws';

class EndpointManagerClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: Function; reject: Function }>();
  private cmdId = 0;
  private nodes = new Map<string, IAIProviderNode>();
  private roles: Record<string, string> = {};

  connect(): void {
    this.ws = new WebSocket('ws://127.0.0.1:3797');

    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if ('id' in msg) {
        // コマンドへのレスポンス
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
        }
      } else if ('event' in msg) {
        // プッシュイベント
        this.handleEvent(msg);
      }
    });

    this.ws.on('close', () => {
      // 2秒後に再接続
      setTimeout(() => this.connect(), 2000);
    });
  }

  private handleEvent(msg: { event: string; data?: any }): void {
    switch (msg.event) {
      case 'scan_completed':
        this.nodes.clear();
        for (const node of msg.data.nodes) {
          this.nodes.set(node.id, node);
        }
        break;
      case 'node_discovered':
        this.nodes.set(msg.data.id, msg.data);
        break;
      case 'node_state_changed':
        const n = this.nodes.get(msg.data.nodeId);
        if (n) n.healthStatus = msg.data.state;
        break;
      case 'models_updated':
        const node = this.nodes.get(msg.data.nodeId);
        if (node) {
          node.availableModels = msg.data.availableModels;
          node.loadedModels = msg.data.loadedModels;
        }
        break;
      case 'node_removed':
        this.nodes.delete(msg.data.nodeId);
        break;
      case 'roles_changed':
        this.roles = msg.data;
        break;
    }
  }

  private send(cmd: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = String(++this.cmdId);
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify({ ...cmd, id }));
    });
  }

  // ──────────────────────────────────────────────
  // 公開 API
  // ──────────────────────────────────────────────

  /** 推論エンドポイントを取得する */
  async resolve(modelId: string, role?: string): Promise<IAIProviderNode> {
    return this.send({ type: 'resolve', modelId, role });
  }

  /** ノード一覧を取得する */
  async list(): Promise<IAIProviderNode[]> {
    return this.send({ type: 'list' });
  }

  /** ネットワーク再スキャンをトリガーする */
  async scan(): Promise<void> {
    return this.send({ type: 'scan' });
  }

  /** ロール割り当てを取得する */
  async getRoles(): Promise<Record<string, string>> {
    return this.send({ type: 'get_roles' });
  }
}
```

### AI 推論の呼び出しパターン

```typescript
const client = new EndpointManagerClient();
client.connect();

// コード補完を行いたいとき
async function getCodeCompletion(messages: { role: string; content: string }[]): Promise<string> {
  // 1. coder ロールのエンドポイントを解決
  const endpoint = await client.resolve('', 'coder');

  // 2. OpenAI 互換 API で推論を呼ぶ
  const res = await fetch(`${endpoint.providerUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.loadedModels[0] ?? endpoint.availableModels[0],
      messages,
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// 計画・推論を行いたいとき（別のロールを使う）
async function getPlannerResponse(prompt: string): Promise<string> {
  const endpoint = await client.resolve('', 'planner');

  const res = await fetch(`${endpoint.providerUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.loadedModels[0] ?? endpoint.availableModels[0],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}
```

### エラーからの自動回復

```typescript
async function callWithFallback(messages: any[], role: string): Promise<string> {
  try {
    const endpoint = await client.resolve('', role);
    const res = await fetch(`${endpoint.providerUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: endpoint.loadedModels[0] ?? endpoint.availableModels[0],
        messages,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      // 推論失敗をサービスに報告（他のクライアントにも共有される）
      client.reportHealth(endpoint.id, res.status === 429 ? 'RateLimited' : 'Offline');
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  } catch (err) {
    // resolve はフォールバックを自動で行うので、再試行すれば別ノードに繋がる
    const fallback = await client.resolve('', role);
    // ...再試行ロジック
  }
}
```

---

## 自動監視（サーバー側）

クライアントが何もしなくても、サービスが以下を自動実行します:

| 処理 | 間隔 | 対象 | 結果 |
|---|---|---|---|
| ヘルス回復チェック | 60秒 | `Offline` / `Unreachable` ノード | 復帰時に `node_state_changed` イベント |
| モデルポーリング | 30秒 | `Online` ノード | 変化時に `models_updated` イベント |

---

## サービスが停止している場合

Endpoint Manager はオプショナルなサービスです。接続できなくてもクライアントは正常に動作しなければなりません。

```typescript
ws.on('close', () => {
  // エンドポイントが不明な状態になるが、エディタは動き続ける
  // 2秒後に再接続を試みる
  setTimeout(() => reconnect(), 2000);
});

ws.on('error', () => {
  // 初回接続できなくても落ちない
});
```

**推奨パターン**: サービス未接続時は `resolve` が使えないので、ハードコードされたフォールバック URL（例: `http://127.0.0.1:1234/v1`）を使う。

---

## ロール名の規約

ロール名は自由な文字列ですが、以下のプリセットを推奨します:

| ロール | 用途 | 推奨モデル特性 |
|---|---|---|
| `planner` | 計画・推論・設計 | 高精度・大パラメータ |
| `coder` | コード生成・補完 | コード特化 |
| `fast` | インライン補完・高速応答 | 低レイテンシ・軽量 |
| `vision` | 画像認識・マルチモーダル | ビジョン対応 |
| `reviewer` | コードレビュー | 高精度 |

---

## 注意事項

- `providerUrl` は OpenAI 互換 API のベース URL（例: `http://192.168.1.22:1234/v1`）
- `availableModels` は `/v1/models` で取得されたモデル ID の配列
- `loadedModels` は LM Studio の VRAM に読み込み済みのモデル（推論準備完了）
- `resolve` はモデル名の部分一致にも対応（`modelId` がモデル ID の末尾に一致すれば OK）
- すべての状態変化はプッシュイベントで通知されるため、ポーリングは不要
