# Endpoint Manager — アーキテクチャ設計書

---

## 1. システム全体図

```
┌──────────────────────────────────────────────────────────────────────┐
│                          利用者層                                     │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Claude Code  │  │ Gemini CLI   │  │ Cursor 等    │  MCP クライアント │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                 │                 │                        │
│         └─────────────────┼─────────────────┘                        │
│                           │ stdio (JSON-RPC)                         │
│                   ┌───────▼──────────┐                               │
│                   │   MCP Server     │                               │
│                   │   (mcp/)         │                               │
│                   └───────┬──────────┘                               │
│                           │                                          │
│  ┌──────────────┐         │ ws://127.0.0.1:3797                      │
│  │ Tauri App    │         │                                          │
│  │ (src-tauri/) ├─spawn─┐ │                                          │
│  └──────────────┘       │ │                                          │
│                         ▼ ▼                                          │
│  ┌──────────────┐  ┌────────────────────────────────────────┐        │
│  │ VS Code Fork │  │         Node.js Backend (src/)         │        │
│  │ Rust Editor  │  │                                        │        │
│  └──────┬───────┘  │  WS Server :3797  │  HTTP Server :3798 │        │
│         │          │       ▲           │       ▲            │        │
│         │ ws://    │       │           │       │            │        │
│         └──────────┤  EndpointManager  │  GUI (index.html)  │        │
│                    │       │           │                    │        │
│                    │  NetworkScanner   │  EndpointStore     │        │
│                    └────────────────────────────┬───────────┘        │
│                                                 │                    │
│                                    ~/.config/endpoint-manager/       │
│                                            store.json                │
└──────────────────────────────────────────────────────────────────────┘
         │
         │ HTTP probe (:1234/v1/models)
         ▼
┌──────────────────────────────────────────┐
│          ローカルネットワーク              │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │LM Studio │  │LM Studio │  │LM Studio│ │
│  │localhost  │  │192.168.  │  │192.168. │ │
│  │:1234      │  │1.22:1234 │  │1.120:   │ │
│  └──────────┘  └──────────┘  │1234     │ │
│                              └────────┘ │
└──────────────────────────────────────────┘
```

---

## 2. コンポーネント詳細

### 2.1 Node.js バックエンド（src/）

プロジェクトの中核。全てのビジネスロジックがここにある。

| ファイル | 行数 | 責務 |
|---|---|---|
| `types.ts` | 83 | 全型定義。WS プロトコルの型安全を保証 |
| `EndpointManager.ts` | 232 | コアロジック。resolve、ロール管理、ヘルス監視タイマー |
| `EndpointStore.ts` | 72 | JSON ファイルへの永続化。ノードとロールの CRUD |
| `NetworkScanner.ts` | 145 | ネットワークスキャン。4サブネット並列、各254ホスト同時プローブ |
| `WsServer.ts` | 174 | WebSocket サーバー。13コマンドのディスパッチ + イベントブロードキャスト |
| `index.ts` | 60 | エントリーポイント。サービス初期化 + HTTP サーバー |

#### データフロー

```
起動時:
  store.json → EndpointStore → EndpointManager (メモリに復元)
  → NetworkScanner.scanNetwork() → 発見したノードを EndpointManager に追加
  → WsServer 待ち受け開始

クライアント接続時:
  WsServer → scan_completed + roles_changed を自動送信（初期同期）

コマンド処理:
  クライアント → WsServer (JSON parse) → EndpointManager (ロジック実行)
  → WsResponse をクライアントに返送
  → 状態変化があれば WsEvent を全クライアントにブロードキャスト

定期処理（バックグラウンド）:
  60秒ごと: Offline/Unreachable ノードを再プローブ（ヘルス回復検出）
  30秒ごと: Online ノードのモデル情報を更新（ロード/アンロード検出）
```

#### resolve の解決ロジック（最重要）

```
resolve(modelId, role?) の優先順位:

1. role 指定あり
   └─ そのロールに割り当てられたノードが Online かつ modelId を持つ → 返す

2. modelId 指定あり
   └─ modelId を持つ Online ノードを探す → 最初に見つかったものを返す
   └─ 部分一致: modelId がノードのモデルIDの末尾に一致すれば OK

3. フォールバック
   └─ モデル不問で Online のノードを返す

4. 全滅
   └─ undefined（エラー）
```

### 2.2 MCP サーバー（mcp/）

バックエンドの WS クライアントとして動作する薄いブリッジ層。

| ツール | 説明 |
|---|---|
| `resolve_endpoint` | ロール/モデルで最適エンドポイントを解決 |
| `list_endpoints` | 全ノード一覧 |
| `list_roles` | ロール割り当て一覧 |
| `scan_network` | ネットワーク再スキャン |
| `assign_role` | ロールをノードに割り当て |
| `chat_completion` | resolve + OpenAI 互換 API で推論実行（SSE ストリーム収集） |

#### バックエンド自動起動の仕組み

```
MCP サーバー起動時:
  1. net.connect でポート 3797 を即座にチェック
  2. listen していない → child_process.spawn (detached + unref) でバックエンド起動
  3. 起動を待たずに MCP 初期化完了
  4. 最初のツール呼び出し時に WS 接続リトライ（最大5回、1秒間隔）
```

#### Claude Code への登録

```json
{
  "mcpServers": {
    "endpoint-manager": {
      "command": "npx",
      "args": ["tsx", "server.ts"],
      "cwd": "/Volumes/2TB_USB/dev/endpoint-manager/mcp"
    }
  }
}
```

### 2.3 Tauri デスクトップアプリ（src-tauri/）

Node.js バックエンドを管理する Rust の殻。

```
起動フロー:
  1. Tauri アプリ起動
  2. setup() で Node.js バックエンドを spawn
     - Node.js パス検出: nvm → Homebrew (ARM) → Homebrew (Intel) → PATH
     - プロジェクトルート検出: cwd → 親ディレクトリ → exe から逆算
  3. stdout/stderr をフォワード
  4. webview で src/gui/index.html を表示（frontendDist）
  5. GUI は ws://127.0.0.1:3797 に接続
  6. ウィンドウ破棄時に child.kill() でバックエンド停止
```

### 2.4 管理 GUI（src/gui/index.html）

単一 HTML ファイル。ビルド不要。

- **Tailwind CSS 3**（CDN）+ **Google Material Symbols**
- **Material Design 3** ダークテーマ（cyan/purple アクセント）
- **Vanilla JS** — フレームワーク依存なし
- WS で直接バックエンドと通信
- 自動再接続（2秒間隔）

---

## 3. WebSocket プロトコル概要

詳細は `SPEC.md` を参照。

### メッセージ種別

| 種別 | 方向 | 識別方法 |
|---|---|---|
| コマンド | クライアント → サーバー | `{ id, type, ...params }` |
| レスポンス | サーバー → クライアント | `{ id, ok, data?, error? }` |
| プッシュイベント | サーバー → 全クライアント | `{ event, data? }` |

### コマンド一覧（13種）

**参照系**: `scan`, `list`, `resolve`, `get_models`, `probe`, `get_roles`
**管理系**: `add_endpoint`, `remove_endpoint`, `assign_role`, `unassign_role`
**双方向同期**: `report_health`, `report_model_loaded`, `report_models`

### イベント一覧（7種）

`scan_started`, `scan_completed`, `node_discovered`, `node_state_changed`, `models_updated`, `node_removed`, `roles_changed`

---

## 4. データモデル

### IAIProviderNode（ノード情報）

```typescript
interface IAIProviderNode {
  id:              string;           // "local-http://192.168.1.22:1234/v1"
  type:            'cloud' | 'local';
  providerType:    ProviderType;     // 'local_lmstudio' | 'remote_lmstudio' | ...
  providerUrl:     string;           // "http://192.168.1.22:1234/v1"
  label?:          string;
  availableModels: string[];         // /v1/models で取得
  loadedModels:    string[];         // VRAM 読み込み済み
  healthStatus:    NodeHealthState;  // Online | Offline | RateLimited | Unreachable
  lastSeenAt:      number;           // Unix ms
}
```

### RoleMap（ロール割り当て）

```typescript
type RoleMap = Record<string, string>;
// 例: { "planner": "local-http://192.168.1.22:1234/v1", "coder": "..." }
```

標準ロール: `planner`（計画）, `coder`（コード生成）, `fast`（高速応答）, `vision`（画像認識）, `reviewer`（レビュー）

### store.json（永続化）

```json
{
  "version": 1,
  "nodes": { "node-id": { ...IAIProviderNode } },
  "roles": { "planner": "node-id" }
}
```

---

## 5. ネットワークスキャン仕様

| 設定 | 値 |
|---|---|
| スキャン対象 | localhost + 192.168.1/0.x + 10.0.0.x + 172.16.0.x |
| LM Studio ポート | 1234 |
| プローブタイムアウト | 3秒/ホスト |
| サブネットタイムアウト | 8秒 |
| 並列度 | サブネット間は並列、サブネット内は全254ホスト同時 |
| プローブ先 | `/v1/models`（OpenAI 互換）+ `/api/v0/models`（LM Studio ネイティブ） |

---

## 6. 依存関係

### バックエンド（src/）
- `ws` ^8.18.0 — WebSocket サーバー
- `tsx` ^4.19.0 — TypeScript ランタイム
- Node.js 組み込み: `http`, `fs`, `path`, `url`, `events`

### MCP サーバー（mcp/）
- `@modelcontextprotocol/sdk` ^1.12.1 — MCP プロトコル
- `ws` ^8.18.0 — WebSocket クライアント
- `zod` ^3.24.0 — スキーマ検証

### Tauri アプリ（src-tauri/）
- `tauri` 2.10.3
- `tauri-plugin-shell` 2.3.5
- Rust 1.77.2+

---

## 7. 設計原則

1. **メモリが正** — ファイルは永続化先、メモリ上の Map が Source of Truth
2. **イベント駆動** — 全状態変化はプッシュイベントでブロードキャスト
3. **オプショナル接続** — サービス停止中でもクライアントはクラッシュしない
4. **モジュール分離** — 機能単位で独立アプリ化。統合はコンテキストウィンドウが十分大きくなるまで保留
5. **テスタビリティ** — ロジックは純粋 TS モジュール。`vscode` 依存なし。`tsx` で単体実行可能
6. **TypeScript = ロジック / Rust = 殻** — Rust は spawn/kill だけ。ロジックは全て TS

---

## 8. 将来の計画

| 項目 | 状態 | 備考 |
|---|---|---|
| テスト実装 | 計画済み（TEST_STRATEGY.md） | resolve ロジックのユニットテストが最優先 |
| クラウド API プロキシ | 決定済み: 別プロジェクト | トークン隠蔽用。Endpoint Manager には統合しない |
| システムトレイ | 未着手 | Tauri のトレイ API でバックグラウンド常駐 |
| Tailwind ローカルバンドル | 未着手 | CDN 依存解消 |
| skosh-editor 統合 | 保留 | AI のコンテキストウィンドウが十分大きくなるまで |
