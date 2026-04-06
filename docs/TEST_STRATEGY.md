# Endpoint Manager — テスト戦略

---

## 1. テスト方針

### 原則（CLAUDE.md のテスト方針に準拠）

- **`tsx` で部分テスト優先** — ビルドもシステム全体起動も不要
- **DI（依存性注入）でモック差し替え** — `fetch` やファイルI/Oは引数やインターフェースで注入
- **部分テストの優先順位**: `tsx` 単体 → `curl` で疎通 → ブラウザ DevTools → システム全体

### テストフレームワーク

`node:test`（Node.js 組み込み）を使用。外部依存ゼロ。

```bash
node --import tsx/esm --test test/**/*.test.ts
```

---

## 2. テスト対象と層

```
┌─────────────────────────────────────────────────┐
│  Layer 1: 純粋ロジック（ユニットテスト）           │
│  - EndpointManager.resolve()                     │
│  - EndpointStore（ファイルI/O）                   │
│  - NetworkScanner.buildNode()                    │
│  - types.ts の型定義の健全性                       │
├─────────────────────────────────────────────────┤
│  Layer 2: プロトコル（統合テスト）                 │
│  - WsServer コマンドディスパッチ                   │
│  - WS プロトコルの request/response               │
│  - プッシュイベントのブロードキャスト               │
├─────────────────────────────────────────────────┤
│  Layer 3: MCP サーバー（end-to-end テスト）       │
│  - MCP ツール呼び出し → WS → バックエンド          │
│  - バックエンド自動起動                            │
│  - chat_completion（推論呼び出し）                 │
├─────────────────────────────────────────────────┤
│  Layer 4: Tauri アプリ（手動テスト）              │
│  - ウィンドウ表示                                  │
│  - サイドカー起動/停止                             │
│  - GUI 操作                                       │
└─────────────────────────────────────────────────┘
```

---

## 3. Layer 1: ユニットテスト

### 3.1 EndpointManager — resolve ロジック

`resolve()` はこのシステムの最重要関数。4段階のフォールバックロジックを持つ。

```
テストケース:
├── ロール指定あり + ノード Online + モデル一致 → そのノードを返す
├── ロール指定あり + ノード Offline → フォールバック
├── ロール指定なし + モデル一致するノードが複数 → 最初のOnlineノード
├── モデル不一致 → モデル不問で Online ノードをフォールバック
├── 全ノード Offline → undefined
├── ノード 0 件 → undefined
└── モデルID の部分一致（末尾一致）→ 正しく解決
```

**現状のテスタビリティ**: `EndpointManager` は `EndpointStore` を DI で受け取るが、`scanNetwork` はモジュールレベルの import。resolve/ロール管理のテストは `EndpointStore` をモックすれば可能。スキャン系のテストには `NetworkScanner` のモックが必要。

**改修案**: `EndpointManager` のコンストラクタに `scanNetwork` 関数を注入可能にする（オプショナル引数）。

### 3.2 EndpointStore — 永続化

```
テストケース:
├── 新規作成 → 空の状態で初期化
├── upsertNode → ファイルに書き込まれる
├── removeNode → ノード削除 + 関連ロールもカスケード削除
├── assignRole / clearRole → ロールの追加・削除
├── 壊れた JSON → デフォルト状態にフォールバック
└── ディレクトリが存在しない → 自動作成
```

**現状のテスタビリティ**: コンストラクタに `path` を受け取るので、テスト用の一時ファイルを指定すれば完全に独立テスト可能。

### 3.3 NetworkScanner — buildNode

`buildNode()` は純粋関数。

```
テストケース:
├── localhost URL → id が "local-" プレフィックス
├── 192.168.x.x → id が "local-" プレフィックス
├── 外部 IP → id が正しく生成
├── /v1 付き/なし URL の正規化
└── ProbeResult の各パターン → IAIProviderNode への変換
```

**現状のテスタビリティ**: 完全に純粋関数。モック不要。

### 3.4 NetworkScanner — probeEndpoint

```
テストケース:
├── 正常応答 → reachable: true + モデル一覧
├── タイムアウト → reachable: false
├── 404 応答 → reachable: false
├── 不正な JSON → reachable: false
└── LM Studio ネイティブ API あり/なし
```

**現状のテスタビリティ**: グローバル `fetch` に依存。テスト用に `fetch` を注入可能にするか、`node:test` の `mock.method(globalThis, 'fetch', ...)` でモック。

---

## 4. Layer 2: 統合テスト（WS プロトコル）

実際に WS サーバーを起動し、WS クライアントでコマンドを送受信する。

```
テストケース:
├── 接続時に scan_completed + roles_changed が届く
├── list コマンド → ノード一覧が返る
├── resolve コマンド → 最適ノードが返る
├── resolve 失敗 → ok: false + error メッセージ
├── scan コマンド → scan_started イベントが飛ぶ
├── add_endpoint → ノード追加 + node_discovered イベント
├── remove_endpoint → node_removed イベント + ロールカスケード削除
├── assign_role → roles_changed イベントが全クライアントに届く
├── report_health → node_state_changed イベントが飛ぶ
├── 複数クライアント同時接続 → 全クライアントにブロードキャスト
├── 不正な JSON → 無視される（クラッシュしない）
└── 未知のコマンド type → error レスポンス
```

**テスト方法**:

```typescript
import { describe, it, before, after } from 'node:test';
import WebSocket from 'ws';
// テスト用の一時ストアでサーバーを起動
// → WS クライアントでコマンド送信
// → レスポンスとイベントを検証
```

ネットワークスキャンのモックが必要な場合は、`EndpointManager` に `addEndpoint` でテスト用ノードを事前投入する。

---

## 5. Layer 3: MCP end-to-end テスト

### 5.1 MCP ツール呼び出し

stdin から JSON-RPC を送り、stdout のレスポンスを検証する。

```
テストケース:
├── initialize → protocolVersion + capabilities が返る
├── tools/list → 6 ツールが返る
├── list_endpoints → ノード一覧の JSON が返る
├── resolve_endpoint(role: "coder") → 適切なノードが返る
├── resolve_endpoint（該当なし） → エラーメッセージ
├── list_roles → ロール割り当てが返る
├── scan_network → "scan started" メッセージ
├── assign_role → 成功メッセージ
└── chat_completion → 推論結果テキストが返る（LM Studio が起動している場合）
```

**テスト方法**:

```bash
echo '<JSON-RPC messages>' | npx tsx server.ts 2>/dev/null | jq .
```

または `node:child_process` で MCP サーバーを spawn し、stdin/stdout で対話。

### 5.2 バックエンド自動起動

```
テストケース:
├── バックエンド停止中 → MCP 起動時に自動で launch される
├── バックエンド起動済み → 二重起動しない
├── MCP 終了 → バックエンドは生き続ける（detached）
└── バックエンド起動中に MCP ツール呼び出し → リトライで接続成功
```

---

## 6. Layer 4: Tauri アプリ（手動テスト）

自動化のコスト対効果が低いため、手動チェックリストとする。

```
チェックリスト:
□ tauri dev でウィンドウが表示される
□ GUI にノード一覧が表示される
□ スキャンボタンでネットワークスキャンが動く
□ ロール割り当てが GUI から操作できる
□ アプリ終了時にバックエンド（サイドカー）も終了する
□ 外部 WS クライアントが接続できる（wscat で確認）
□ tauri build で .app が生成される
```

---

## 7. テスタビリティ改善が必要な箇所

現状のコードでテストを書くにあたり、最小限の改修が望ましい箇所:

### 7.1 NetworkScanner — fetch の注入

`probeEndpoint` がグローバル `fetch` に直接依存している。

**改修**: 関数の引数にオプショナルな `fetcher` を追加。

```typescript
export async function probeEndpoint(
  baseUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ProbeResult> {
```

### 7.2 EndpointManager — スキャナーの注入

`EndpointManager` が `scanNetwork` / `probeEndpoint` をモジュールレベルで import している。

**改修**: コンストラクタのオプションオブジェクトで注入可能にする。

```typescript
interface EndpointManagerOptions {
  scanner?: typeof scanNetwork;
  prober?: typeof probeEndpoint;
}
```

### 7.3 EndpointStore — fs の注入は不要

コンストラクタに `path` を受け取るため、テスト用の一時ディレクトリを指定すれば十分。`node:fs` のモックは不要。

---

## 8. ディレクトリ構成

```
endpoint-manager/
├── test/
│   ├── unit/
│   │   ├── resolve.test.ts          # EndpointManager.resolve のロジック
│   │   ├── store.test.ts            # EndpointStore の CRUD + カスケード削除
│   │   └── build-node.test.ts       # NetworkScanner.buildNode の変換
│   ├── integration/
│   │   ├── ws-protocol.test.ts      # WS コマンド/レスポンス/イベント
│   │   └── multi-client.test.ts     # 複数クライアント同時接続
│   └── e2e/
│       ├── mcp-tools.test.ts        # MCP ツール呼び出し
│       └── auto-launch.test.ts      # バックエンド自動起動
├── src/
├── mcp/
└── package.json  ← "test" スクリプト追加
```

---

## 9. 実行方法

```bash
# 全テスト
npm test

# ユニットテストのみ
npm run test:unit

# 統合テストのみ（WS サーバーを実際に起動する）
npm run test:integration

# e2e（バックエンドの起動が必要）
npm run test:e2e
```

### package.json に追加するスクリプト

```json
{
  "scripts": {
    "test": "node --import tsx/esm --test test/**/*.test.ts",
    "test:unit": "node --import tsx/esm --test test/unit/**/*.test.ts",
    "test:integration": "node --import tsx/esm --test test/integration/**/*.test.ts",
    "test:e2e": "node --import tsx/esm --test test/e2e/**/*.test.ts"
  }
}
```

---

## 10. テスト優先順位

実装順序の推奨:

| 優先度 | テスト | 理由 |
|---|---|---|
| **1** | `resolve.test.ts` | 最重要関数。フォールバックロジックのバグは即障害 |
| **2** | `store.test.ts` | カスケード削除のバグは状態不整合を起こす |
| **3** | `ws-protocol.test.ts` | プロトコル違反はクライアント全体に影響 |
| **4** | `build-node.test.ts` | 純粋関数で簡単に書ける |
| **5** | `mcp-tools.test.ts` | MCP ツールの動作保証 |
| **6** | `auto-launch.test.ts` | バックエンド自動起動の信頼性 |
| **7** | `multi-client.test.ts` | 複数接続時のブロードキャスト正確性 |

---

## 11. リモート環境でのテスト（将来）

Mac mini (192.168.1.22) でのクロスプラットフォームテスト:

```bash
# WoL で起動
python3 -c "import socket; mac='d0:11:e5:d9:7b:12'; ..."

# テストを実行
ssh primalcolors@192.168.1.22 'cd /path/to/endpoint-manager && npm test'
```

Windows (192.168.1.41) での動作確認:
```bash
ssh -o ProxyJump=none pcadmin@192.168.1.41 'cd /path && npm test'
```

これは Endpoint Manager のネットワークスキャン機能が異なるネットワーク構成で正しく動作することを確認するために有用。ただし優先度は低い。
