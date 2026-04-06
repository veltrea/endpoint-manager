# Endpoint Manager — 仕様書

> **対象読者**
> このドキュメントは、Endpoint Manager サービスに接続するクライアントを実装するAI・開発者向けに書かれています。
> 特に VS Code Fork（skosh-editor）や Rust 製エディタから WebSocket で接続するクライアントの実装者を想定しています。

---

## 1. 概要

Endpoint Manager は、ローカルネットワーク上の AI 推論エンドポイント（主に LM Studio）を**自動検出・管理・監視**するスタンドアローンのデーモンサービスです。

クライアント（エディタ等）は WebSocket で接続し、以下をアウトソースできます：

- ネットワーク上の LM Studio インスタンスを探す
- どのノードがオンラインか・何のモデルを持っているかを知る
- ロール（`planner` / `coder` / `fast` 等）に基づいて最適なエンドポイントを取得する
- 状態の永続化・復元

クライアントは AI の推論ロジックだけに集中できます。接続先管理はすべてこのサービスが担います。

---

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│                 Endpoint Manager                    │
│                                                     │
│  ┌─────────────┐   ┌──────────────┐                │
│  │ NetworkScanner│   │EndpointStore │                │
│  │（スキャン）   │   │（JSON永続化） │                │
│  └──────┬──────┘   └──────┬───────┘                │
│         │                 │                         │
│  ┌──────▼─────────────────▼───────┐                │
│  │        EndpointManager         │                │
│  │  （メモリ管理・ヘルス監視）       │                │
│  └──────────────┬─────────────────┘                │
│                 │ EventEmitter                      │
│  ┌──────────────▼─────────────────┐                │
│  │          WsServer               │                │
│  │  （WebSocket :3797）            │                │
│  └─────────────────────────────────┘                │
│                                                     │
│  ┌─────────────────────────────────┐                │
│  │       HTTP Server :3798         │                │
│  │  （管理 GUI を提供）              │                │
│  └─────────────────────────────────┘                │
└─────────────────────────────────────────────────────┘
         ▲                    ▲
         │ WebSocket          │ HTTP
  ┌──────┴──────┐    ┌───────┴──────┐
  │ VS Code Fork │    │   Browser    │
  │ Rust Editor  │    │  (管理画面)   │
  └─────────────┘    └──────────────┘
```

### 設計原則

- **メモリが正（Source of Truth）**: ノード情報はメモリ上の `Map<id, IAIProviderNode>` が正。ファイル（JSON）は永続化のための書き出し先に過ぎない
- **イベント駆動**: 状態変化はすべて `WsEvent` としてすべての接続クライアントにブロードキャストされる
- **双方向同期**: クライアントが観測した状態（モデル読み込み・ヘルス変化等）をサービスに報告できる

---

## 3. 起動・設定

### 起動方法

```bash
./launch.sh        # サービス起動 + Chrome アプリモードで管理 GUI を開く
./stop.sh          # サービス停止
```

直接起動する場合：

```bash
node --import tsx/esm src/index.ts
```

### 環境変数

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `EM_WS_PORT` | `3797` | WebSocket サーバーのポート |
| `EM_HTTP_PORT` | `3798` | HTTP（管理 GUI）サーバーのポート |
| `EM_STORE_PATH` | `~/.config/endpoint-manager/store.json` | 永続化 JSON ファイルのパス |

### 起動時の動作

1. `store.json` からノード・ロール情報を復元
2. ネットワーク自動スキャンを開始
3. WebSocket サーバー（:3797）と HTTP サーバー（:3798）を起動
4. ヘルス監視タイマー（60秒）・モデルポーリングタイマー（30秒）を開始

---

## 4. データ型定義

クライアントが扱う主要な型です。TypeScript で実装する場合はそのまま利用できます。

### `IAIProviderNode` — ノード情報

```typescript
interface IAIProviderNode {
  id:              string;         // ノード固有ID。例: "local-http://192.168.1.22:1234/v1"
  type:            'cloud' | 'local';
  providerType:    ProviderType;   // 後述
  providerUrl:     string;         // エンドポイントのベースURL。例: "http://192.168.1.22:1234/v1"
  label?:          string;         // 任意の表示名
  availableModels: string[];       // /v1/models で取得したモデルID一覧
  loadedModels:    string[];       // VRAM に読み込み済みのモデルID一覧（LM Studio ネイティブ API）
  healthStatus:    NodeHealthState;
  lastSeenAt:      number;         // Unix ミリ秒
}
```

#### `NodeHealthState` — ヘルス状態

```typescript
enum NodeHealthState {
  Online      = 'Online',       // 応答あり・正常
  Offline     = 'Offline',      // 接続拒否
  RateLimited = 'RateLimited',  // HTTP 429
  Unreachable = 'Unreachable',  // タイムアウト・到達不能
}
```

#### `ProviderType` — プロバイダー種別

```typescript
type ProviderType =
  | 'local_lmstudio'   // localhost の LM Studio
  | 'remote_lmstudio'  // ネットワーク上の LM Studio
  | 'lmstudio'         // 汎用
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'custom';
```

### `RoleMap` — ロール割り当て

```typescript
type RoleMap = Record<string, string>;
// 例: { "planner": "local-http://192.168.1.22:1234/v1", "coder": "..." }
```

ロール名は任意の文字列。システム標準のプリセットは以下ですが、制限はありません：

| ロール名 | 用途 |
|---|---|
| `planner` | 計画・推論（高精度モデル向け） |
| `coder` | コード生成 |
| `fast` | 高速応答（軽量モデル向け） |
| `vision` | 画像認識 |
| `reviewer` | コードレビュー |

---

## 5. WebSocket プロトコル

### 接続

```
ws://127.0.0.1:3797
```

接続後、サーバーは即座に以下の2つのイベントをクライアントに送信します（初期同期）：

1. `scan_completed` — 現在のノード一覧
2. `roles_changed` — 現在のロール割り当て

### メッセージフォーマット

すべてのメッセージは JSON です。

#### クライアント → サーバー（コマンド）

```json
{
  "id": "任意のユニークな文字列（レスポンスの対応付けに使用）",
  "type": "コマンド名",
  ...コマンド固有のフィールド
}
```

#### サーバー → クライアント（レスポンス）

コマンドに対する返答。`id` でコマンドと対応付けます。

```json
{
  "id": "コマンドと同じID",
  "ok": true,
  "data": { ...結果 }
}
```

エラー時：

```json
{
  "id": "コマンドと同じID",
  "ok": false,
  "error": "エラーメッセージ"
}
```

#### サーバー → クライアント（プッシュイベント）

`id` フィールドを持たないメッセージはサーバーからのプッシュイベントです。

```json
{
  "event": "イベント名",
  "data": { ...イベント固有のデータ }
}
```

---

## 6. コマンドリファレンス

### 探索・参照系

#### `scan` — ネットワークスキャン

ネットワーク全体をスキャンして LM Studio を探します。スキャン中は `scan_started` → （`node_discovered` × N）→ `scan_completed` の順でイベントが届きます。

```json
// リクエスト
{ "id": "1", "type": "scan" }

// レスポンス（スキャン開始を確認後すぐに返る。完了は scan_completed イベントで受け取る）
{ "id": "1", "ok": true, "data": null }
```

---

#### `list` — ノード一覧取得

現在管理しているノードをすべて返します。

```json
// リクエスト
{ "id": "2", "type": "list" }

// レスポンス
{
  "id": "2",
  "ok": true,
  "data": [
    {
      "id": "local-http://127.0.0.1:1234/v1",
      "type": "local",
      "providerType": "local_lmstudio",
      "providerUrl": "http://127.0.0.1:1234/v1",
      "availableModels": ["llama-3-8b", "gemma-2-9b"],
      "loadedModels": ["llama-3-8b"],
      "healthStatus": "Online",
      "lastSeenAt": 1712345678000
    }
  ]
}
```

---

#### `resolve` — 最適ノードの解決

**エディタが AI 推論を行いたいときに呼ぶ最重要コマンドです。**

モデルIDとロールを指定し、使用すべきエンドポイントを取得します。

```json
// リクエスト
{
  "id": "3",
  "type": "resolve",
  "modelId": "llama-3-8b",   // 使いたいモデルID
  "role": "coder"            // 省略可。ロールを指定するとそのノードを優先
}

// レスポンス
{
  "id": "3",
  "ok": true,
  "data": {
    "id": "local-http://192.168.1.22:1234/v1",
    "providerUrl": "http://192.168.1.22:1234/v1",
    ...IAIProviderNode の全フィールド
  }
}
```

**解決ロジック（優先順位）：**

1. `role` が指定されており、そのロールに割り当てられたノードがオンラインかつ指定モデルを持つ → そのノードを返す
2. 指定モデルを持つオンラインのノードを探す → 最初に見つかったノードを返す
3. モデルを問わずオンラインのノードを返す（フォールバック）
4. 見つからない場合 → `ok: false`

---

#### `get_models` — 特定ノードのモデル一覧取得

```json
// リクエスト
{ "id": "4", "type": "get_models", "endpointId": "local-http://127.0.0.1:1234/v1" }

// レスポンス
{
  "id": "4",
  "ok": true,
  "data": {
    "availableModels": ["llama-3-8b", "gemma-2-9b"],
    "loadedModels": ["llama-3-8b"]
  }
}
```

---

#### `probe` — 単一ノードのプローブ

指定ノードに接続して最新情報（ヘルス・モデル）を取得します。

```json
// リクエスト
{ "id": "5", "type": "probe", "endpointId": "local-http://127.0.0.1:1234/v1" }

// レスポンス（更新済みのノード情報を返す）
{ "id": "5", "ok": true, "data": { ...IAIProviderNode } }
```

---

#### `get_roles` — ロール割り当て取得

```json
// リクエスト
{ "id": "6", "type": "get_roles" }

// レスポンス
{
  "id": "6",
  "ok": true,
  "data": {
    "planner": "local-http://192.168.1.22:1234/v1",
    "coder":   "local-http://127.0.0.1:1234/v1"
  }
}
```

---

### 管理系

#### `add_endpoint` — エンドポイントを手動追加

```json
// リクエスト
{
  "id": "7",
  "type": "add_endpoint",
  "url": "http://192.168.1.50:1234/v1",
  "label": "GPU Server"     // 省略可
}

// レスポンス（追加されたノード情報）
{ "id": "7", "ok": true, "data": { ...IAIProviderNode } }
```

---

#### `remove_endpoint` — エンドポイントを削除

```json
// リクエスト
{ "id": "8", "type": "remove_endpoint", "endpointId": "local-http://192.168.1.50:1234/v1" }

// レスポンス
{ "id": "8", "ok": true, "data": null }
```

---

#### `assign_role` — ロールを割り当て

```json
// リクエスト
{
  "id": "9",
  "type": "assign_role",
  "role": "coder",
  "endpointId": "local-http://192.168.1.22:1234/v1"
}

// レスポンス
{ "id": "9", "ok": true, "data": null }
```

割り当て後、全クライアントに `roles_changed` イベントがブロードキャストされます。

---

#### `unassign_role` — ロールの割り当てを解除

```json
// リクエスト
{ "id": "10", "type": "unassign_role", "role": "coder" }

// レスポンス
{ "id": "10", "ok": true, "data": null }
```

---

### 双方向同期系

エディタが AI 推論を実行する過程で観測した情報をサービスに報告するコマンドです。これにより、サービス側のポーリングを待たずに最新状態を共有できます。

#### `report_health` — ヘルス状態を報告

```json
{
  "id": "11",
  "type": "report_health",
  "endpointId": "local-http://192.168.1.22:1234/v1",
  "state": "Online"   // NodeHealthState の値
}
```

---

#### `report_model_loaded` — モデルの読み込みを報告

```json
{
  "id": "12",
  "type": "report_model_loaded",
  "endpointId": "local-http://192.168.1.22:1234/v1",
  "modelId": "llama-3-70b"
}
```

---

#### `report_models` — モデル一覧をまとめて報告

```json
{
  "id": "13",
  "type": "report_models",
  "endpointId": "local-http://192.168.1.22:1234/v1",
  "availableModels": ["llama-3-8b", "llama-3-70b"],
  "loadedModels":    ["llama-3-70b"]
}
```

---

## 7. プッシュイベントリファレンス

サーバーからクライアントに一方的に送られるイベントです。`id` フィールドはありません。

### `node_discovered` — 新しいノードを発見

スキャン中に新しいノードが見つかったとき。

```json
{
  "event": "node_discovered",
  "data": { ...IAIProviderNode }
}
```

---

### `node_state_changed` — ノードのヘルスが変化

```json
{
  "event": "node_state_changed",
  "data": {
    "nodeId": "local-http://192.168.1.22:1234/v1",
    "state": "Offline"
  }
}
```

---

### `models_updated` — ノードのモデル情報が更新

```json
{
  "event": "models_updated",
  "data": {
    "nodeId": "local-http://192.168.1.22:1234/v1",
    "availableModels": ["llama-3-8b", "gemma-2-9b"],
    "loadedModels":    ["gemma-2-9b"]
  }
}
```

---

### `node_removed` — ノードが削除された

```json
{
  "event": "node_removed",
  "data": { "nodeId": "local-http://192.168.1.22:1234/v1" }
}
```

---

### `scan_started` — スキャン開始

```json
{ "event": "scan_started" }
```

---

### `scan_completed` — スキャン完了

```json
{
  "event": "scan_completed",
  "data": {
    "found": 3,
    "nodes": [ ...IAIProviderNode[] ]
  }
}
```

---

### `roles_changed` — ロール割り当てが変更

```json
{
  "event": "roles_changed",
  "data": {
    "planner": "local-http://192.168.1.22:1234/v1",
    "coder":   "local-http://127.0.0.1:1234/v1"
  }
}
```

---

## 8. クライアント実装ガイド（VS Code Fork / Rust エディタ向け）

### 接続の初期化

```typescript
const ws = new WebSocket('ws://127.0.0.1:3797');

ws.on('open', () => {
  // 接続直後にサーバーから scan_completed + roles_changed が届く
  // → それを受け取って初期状態を構築すればよい
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);

  if ('id' in msg) {
    // コマンドへのレスポンス
    handleResponse(msg);
  } else if ('event' in msg) {
    // サーバーからのプッシュイベント
    handleEvent(msg);
  }
});
```

### 推論エンドポイントの取得パターン

```typescript
// コード補完を行いたいとき
async function getCodeCompletionEndpoint(): Promise<string> {
  const response = await sendCommand({
    id: uuid(),
    type: 'resolve',
    modelId: '',       // モデル不問の場合は空文字
    role: 'coder',     // coder ロールに割り当てられたノードを優先
  });

  if (!response.ok) throw new Error('No available endpoint');
  return response.data.providerUrl;  // "http://192.168.1.22:1234/v1"
}

// 取得したエンドポイントで OpenAI 互換 API を呼ぶ
const res = await fetch(`${providerUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'llama-3-8b', messages: [...] }),
});
```

### 状態変化を監視して UI に反映

```typescript
function handleEvent(msg) {
  switch (msg.event) {
    case 'node_state_changed':
      // ステータスバーのインジケータを更新するなど
      updateNodeStatus(msg.data.nodeId, msg.data.state);
      break;

    case 'scan_completed':
      // 利用可能なエンドポイントの一覧を更新
      refreshEndpointList(msg.data.nodes);
      break;

    case 'roles_changed':
      // ロール割り当てキャッシュを更新
      updateRoleCache(msg.data);
      break;
  }
}
```

### サービスが起動していない場合の扱い

Endpoint Manager はオプショナルなサービスです。接続できなくてもエディタはクラッシュしてはいけません。

```typescript
ws.on('close', () => {
  // エンドポイントが不明な状態になるが、エディタは動き続ける
  // 2秒後に再接続を試みる
  setTimeout(reconnect, 2000);
});
```

---

## 9. ネットワークスキャン仕様

### スキャン対象

| 対象 | 詳細 |
|---|---|
| localhost | `127.0.0.1:1234` を常に最初にチェック |
| 192.168.1.0/24 | .1 〜 .254 全ホスト |
| 192.168.0.0/24 | .1 〜 .254 全ホスト |
| 10.0.0.0/24 | .1 〜 .254 全ホスト |
| 172.16.0.0/24 | .1 〜 .254 全ホスト |

### プローブ仕様

各ホストの `:1234/v1/models` に対して HTTP GET を送信します。

| 設定 | 値 |
|---|---|
| ポート | `1234`（LM Studio のデフォルト） |
| タイムアウト（1ホスト） | 3秒 |
| サブネットタイムアウト | 8秒 |
| 並列実行 | サブネット単位で並列、サブネット内は全ホスト同時 |

### 検出後の追加取得

応答があったホストに対して LM Studio ネイティブ API `/api/v0/models` も呼び出し、VRAM に読み込まれているモデル（`state: "loaded"`）を `loadedModels` に格納します。

---

## 10. 自動監視

### ヘルスリカバリー（60秒間隔）

`Offline` または `Unreachable` 状態のノードを自動的に再プローブします。復帰した場合は `node_state_changed` イベントでクライアントに通知されます。

### モデルポーリング（30秒間隔）

`Online` 状態のノードのモデル情報を定期的に更新します。LM Studio でモデルのロード・アンロードが行われると `models_updated` イベントが届きます。

---

## 11. 永続化

ノード情報とロール割り当ては `~/.config/endpoint-manager/store.json` に保存されます。

```json
{
  "version": 1,
  "nodes": {
    "local-http://127.0.0.1:1234/v1": {
      "id": "local-http://127.0.0.1:1234/v1",
      "providerUrl": "http://127.0.0.1:1234/v1",
      "providerType": "local_lmstudio",
      ...
    }
  },
  "roles": {
    "planner": "local-http://192.168.1.22:1234/v1",
    "coder":   "local-http://127.0.0.1:1234/v1"
  }
}
```

サービス再起動時にこのファイルから状態を復元します。

---

## 12. ファイル構成

```
endpoint-manager/
├── src/
│   ├── index.ts            # エントリーポイント（HTTP + WS サーバー起動、自動スキャン）
│   ├── types.ts            # 全型定義（IAIProviderNode, WsCommand, WsEvent 等）
│   ├── EndpointManager.ts  # コアロジック（ノード管理・ロール管理・ヘルス監視）
│   ├── EndpointStore.ts    # JSON 永続化
│   ├── NetworkScanner.ts   # ネットワークスキャン・プローブ
│   ├── WsServer.ts         # WebSocket サーバー（コマンドディスパッチ）
│   └── gui/
│       └── index.html      # 管理 UI（Tailwind CSS + Vanilla JS）
├── launch.sh               # 起動スクリプト（サービス + Chrome アプリモード）
├── stop.sh                 # 停止スクリプト
├── package.json
├── tsconfig.json
└── SPEC.md                 # このファイル
```

---

## 13. 将来の統合について（skosh-editor 向けメモ）

このサービスは将来的に skosh-editor（Electron + TypeScript）に統合することを前提に設計されています。

### 統合時の方針

- `EndpointManager.ts` / `NetworkScanner.ts` / `EndpointStore.ts` / `types.ts` は **純粋な TypeScript モジュール** であり、Electron の main プロセスにそのままコピーして使えます
- `vscode` API や DOM への依存はなく、Node.js の標準モジュール（`EventEmitter`, `fs`）と `fetch` のみ使用しています
- 管理 GUI は VS Code の **WebView** としてそのまま埋め込めます
- `WsServer.ts` は外部クライアント向けに残しつつ、内部通信は `ipcMain` / `ipcRenderer` に切り替えることもできます

### 外部サービスとして使い続ける場合

skosh-editor に統合せず、スタンドアローンサービスのまま使い続ける場合は、エディタ起動時に以下を行うだけで接続できます：

1. `ws://127.0.0.1:3797` に WebSocket 接続
2. 接続後に届く `scan_completed` + `roles_changed` で初期状態を構築
3. 推論が必要なときに `resolve` コマンドでエンドポイントを取得
