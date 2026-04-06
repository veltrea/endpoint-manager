# Endpoint Manager — テスト実行レポート

**実施日**: 2026-04-06
**Node.js**: v22.17.0
**フレームワーク**: node:test（組み込み）+ tsx

---

## 1. テスト環境の整備

### 1.1 ディレクトリ構成

```
test/
├── unit/
│   ├── resolve.test.ts       # EndpointManager.resolve のフォールバックロジック
│   ├── store.test.ts         # EndpointStore の CRUD + カスケード削除
│   └── build-node.test.ts    # NetworkScanner.buildNode の変換ロジック
├── integration/
│   └── ws-protocol.test.ts   # WS コマンド/レスポンス/イベント統合テスト
└── e2e/
    └── mcp-tools.test.ts     # MCP ツール呼び出し（JSON-RPC over stdio）
```

### 1.2 package.json スクリプト

```json
{
  "test": "node --import tsx/esm --test test/**/*.test.ts",
  "test:unit": "node --import tsx/esm --test test/unit/**/*.test.ts",
  "test:integration": "node --import tsx/esm --test test/integration/**/*.test.ts",
  "test:e2e": "node --import tsx/esm --test test/e2e/**/*.test.ts"
}
```

### 1.3 テスタビリティ改善（プロダクションコード変更）

| ファイル | 変更内容 | 影響 |
|---|---|---|
| `NetworkScanner.ts` | `probeEndpoint()` に `fetcher` 引数を追加（DI） | 既存の呼び出し元はデフォルト引数で動作変更なし |
| `EndpointManager.ts` | `EndpointManagerOptions` で `scanner`/`prober`/`disableTimers` を注入可能に | コンストラクタの第2引数はオプショナルで後方互換 |

---

## 2. Layer 1: ユニットテスト

### 2.1 resolve.test.ts — EndpointManager.resolve()

最重要関数。4段階フォールバックロジックの全パスをカバー。

| # | テストケース | 結果 |
|---|---|---|
| 1 | モデル一致する Online ノードを返す | ✅ pass |
| 2 | モデル部分一致（末尾一致 `publisher/model-x` → `model-x`）で解決 | ✅ pass |
| 3 | ロール指定あり + Online + モデル一致 → そのノードを返す | ✅ pass |
| 4 | ロール指定あり + ノード Offline → フォールバック | ✅ pass |
| 5 | ロール指定なし + 複数ノードがモデル一致 → 最初の Online ノード | ✅ pass |
| 6 | モデル不一致 → モデル不問で Online ノードをフォールバック | ✅ pass |
| 7 | 全ノード Offline → undefined | ✅ pass |
| 8 | ノード 0 件 → undefined | ✅ pass |
| 9 | ロール指定あり + モデル不一致 → フォールバック（モデル不問） | ✅ pass |

**結果: 9/9 pass**

### 2.2 store.test.ts — EndpointStore

永続化ストアの CRUD とエッジケース。

| # | テストケース | 結果 |
|---|---|---|
| 1 | 新規作成 → 空の状態で初期化 | ✅ pass |
| 2 | upsertNode → ファイルに書き込まれる | ✅ pass |
| 3 | removeNode → ノード削除 | ✅ pass |
| 4 | removeNode → 存在しないノード → false | ✅ pass |
| 5 | removeNode → 関連ロールもカスケード削除 | ✅ pass |
| 6 | assignRole / clearRole → ロールの追加・削除 | ✅ pass |
| 7 | 壊れた JSON → デフォルト状態にフォールバック | ✅ pass |
| 8 | ディレクトリが存在しない → 自動作成 | ✅ pass |
| 9 | ファイルから復元できる（永続化の検証） | ✅ pass |

**結果: 9/9 pass**

### 2.3 build-node.test.ts — NetworkScanner.buildNode()

純粋関数。モック不要。

| # | テストケース | 結果 |
|---|---|---|
| 1 | localhost URL → id が "local-" プレフィックス | ✅ pass |
| 2 | localhost の別表記でも local | ✅ pass |
| 3 | 192.168.x.x → id が "local-" プレフィックス | ✅ pass |
| 4 | 10.x.x.x → id が "local-" プレフィックス | ✅ pass |
| 5 | 172.16-31.x.x → id が "local-" プレフィックス | ✅ pass |
| 6 | 外部 IP → id が "remote-" プレフィックス | ✅ pass |
| 7 | モデル情報が正しく転写される | ✅ pass |
| 8 | Online 状態で生成される | ✅ pass |
| 9 | providerType を指定できる | ✅ pass |
| 10 | providerUrl が保存される | ✅ pass |

**結果: 10/10 pass**

---

## 3. Layer 2: 統合テスト

### 3.1 ws-protocol.test.ts — WS プロトコル

実際に WS サーバー（ポート 13797）を起動し、WS クライアントでコマンドを送受信。

| # | テストケース | 結果 |
|---|---|---|
| 1 | 接続時に scan_completed + roles_changed が届く | ✅ pass |
| 2 | list コマンド → ノード一覧が返る | ✅ pass |
| 3 | resolve コマンド → モデル一致するノードが返る | ✅ pass |
| 4 | resolve 失敗（全 Offline）→ ok: false + error | ✅ pass |
| 5 | get_roles コマンド → ロール割り当てが返る | ✅ pass |
| 6 | assign_role → roles_changed イベントが届く | ✅ pass |
| 7 | 不正な JSON → クラッシュしない | ✅ pass |
| 8 | 未知のコマンド type → error レスポンス | ✅ pass |
| 9 | remove_endpoint → node_removed イベントが届く | ✅ pass |

**結果: 9/9 pass**

---

## 4. Layer 3: e2e テスト

### 4.1 mcp-tools.test.ts — MCP ツール呼び出し

バックエンド（WS サーバー、ポート 14797）を起動し、MCP サーバーを `child_process.spawn` で立ち上げ、
stdin/stdout で JSON-RPC (JSONL 改行区切り) をやり取りして検証。

**注意**: MCP SDK v1.29 は Content-Length ヘッダー方式ではなく JSONL（改行区切り JSON）に変更されている。

| # | テストケース | 結果 |
|---|---|---|
| 1 | initialize → protocolVersion + capabilities が返る | ✅ pass |
| 2 | tools/list → 6 ツールが返る（名前一覧も検証） | ✅ pass |
| 3 | list_endpoints → ノード一覧の JSON が返る | ✅ pass |
| 4 | list_roles → ロール割り当てが返る | ✅ pass |
| 5 | scan_network → "scan started" メッセージ | ✅ pass |
| 6 | resolve_endpoint（該当なし）→ エラーメッセージ | ✅ pass |

**結果: 6/6 pass**

---

## 5. 全テスト一括実行結果

```
$ npm test

# tests 43
# suites 5
# pass 43
# fail 0
# cancelled 0
# skipped 0
# duration_ms 19360ms
```

### 内訳

| レイヤー | ファイル | テスト数 | 所要時間 |
|---|---|---|---|
| Layer 1 (unit) | resolve.test.ts | 9 | ~8ms |
| Layer 1 (unit) | store.test.ts | 9 | ~7ms |
| Layer 1 (unit) | build-node.test.ts | 10 | ~3ms |
| Layer 2 (integration) | ws-protocol.test.ts | 9 | ~29ms |
| Layer 3 (e2e) | mcp-tools.test.ts | 6 | ~4178ms |
| **合計** | | **43** | **~19.4s** |

e2e テストの所要時間が長いのは、バックエンド起動待ち + MCP サーバーの WS 接続安定化待ちによるもの。

---

## 6. 発見事項

### MCP stdio transport は JSONL 方式（Content-Length ヘッダーは存在しない）

MCP の stdio transport は **最初から JSONL（改行区切り JSON）方式**。

- 形式: `{json}\n`（1行1メッセージ）
- Content-Length ヘッダーは **MCP stdio には元から存在しない**

e2e テスト初回は Content-Length ヘッダーを付けて送信して失敗した。
これは AI が LSP の Content-Length フレーミングを MCP にも適用してしまう典型的な誤りで、
SDK ソースコード（`shared/stdio.js`）を読んで改行区切りだと確認し、修正して通過した。

## 7. 今後の課題

| 優先度 | 項目 | 状態 |
|---|---|---|
| 中 | バックエンド自動起動テスト（auto-launch.test.ts） | 未実装 |
| 中 | 複数クライアント同時接続テスト（multi-client.test.ts） | 未実装 |
| 低 | probeEndpoint の fetch モック テスト | 未実装（DI 済み、テスト未作成） |
| 低 | Mac mini リモート実行検証 | 未実装 |
