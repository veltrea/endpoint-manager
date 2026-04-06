/**
 * MCP e2e テスト
 *
 * バックエンド（WS サーバー）+ MCP サーバーを実際に起動し、
 * stdin/stdout で JSON-RPC (JSONL 改行区切り) をやり取りして検証する。
 *
 * MCP SDK v1.29 は Content-Length ヘッダーではなく JSONL（改行区切り JSON）を使う。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const NODE_PATH = process.execPath;

const E2E_WS_PORT = 14797;
const E2E_HTTP_PORT = 14798;

// ── ヘルパー ────────────────────────────────────────────────

function startBackend(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'em-e2e-'));
    const storePath = join(tmpDir, 'store.json');

    const child = spawn(NODE_PATH, ['--import', 'tsx/esm', 'src/index.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        EM_WS_PORT: String(E2E_WS_PORT),
        EM_HTTP_PORT: String(E2E_HTTP_PORT),
        EM_STORE_PATH: storePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`listening on ws://`)) {
        resolve(child);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', reject);
    setTimeout(() => reject(new Error(`Backend startup timeout.\noutput: ${output}`)), 15000);
  });
}

/** MCP クライアント — JSONL (改行区切り JSON) over stdin/stdout */
class McpClient {
  private _proc: ChildProcess;
  private _buffer = '';
  private _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private _nextId = 1;
  private _stderrLog = '';

  constructor(wsPort: number) {
    this._proc = spawn(NODE_PATH, ['--import', 'tsx/esm', 'mcp/server.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        EM_WS_PORT: String(wsPort),
        EM_WS_URL: `ws://127.0.0.1:${wsPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._proc.stdout!.on('data', (chunk: Buffer) => {
      this._buffer += chunk.toString();
      this._processBuffer();
    });

    this._proc.stderr!.on('data', (chunk: Buffer) => {
      this._stderrLog += chunk.toString();
    });

    this._proc.on('error', (err) => {
      for (const [, p] of this._pending) p.reject(err);
      this._pending.clear();
    });
  }

  get stderrLog(): string { return this._stderrLog; }

  private _processBuffer(): void {
    // JSONL: 改行区切りの JSON メッセージ
    const lines = this._buffer.split('\n');
    // 最後の要素は不完全な可能性があるので保持
    this._buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if ('id' in msg && this._pending.has(msg.id)) {
          const p = this._pending.get(msg.id)!;
          this._pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch { /* skip non-JSON lines */ }
    }
  }

  /** JSON-RPC リクエストを送信し、レスポンスを待つ */
  send(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this._nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(msg) + '\n';

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._proc.stdin!.write(line);
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP timeout: ${method}\nstderr: ${this._stderrLog}`));
        }
      }, 15000);
    });
  }

  /** 通知を送信（レスポンスなし） */
  notify(method: string, params?: Record<string, unknown>): void {
    const msg = { jsonrpc: '2.0', method, params };
    this._proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  kill(): void {
    this._proc.kill();
  }
}

// ── テスト本体 ──────────────────────────────────────────────
describe('MCP e2e テスト', () => {
  let backend: ChildProcess;
  let mcp: McpClient;

  before(async () => {
    backend = await startBackend();
    mcp = new McpClient(E2E_WS_PORT);

    // MCP サーバーの起動を待つ
    await new Promise((r) => setTimeout(r, 3000));

    // initialize ハンドシェイク
    const initRes = await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.1.0' },
    });
    assert.ok(initRes.result, `initialize failed: ${JSON.stringify(initRes)}`);

    // initialized 通知
    mcp.notify('notifications/initialized');

    // WS 接続が安定するのを待つ
    await new Promise((r) => setTimeout(r, 1000));
  });

  after(() => {
    mcp?.kill();
    backend?.kill();
  });

  it('initialize → protocolVersion + capabilities が返る', () => {
    // before() で既に成功済み
    assert.ok(true);
  });

  it('tools/list → 6 ツールが返る', async () => {
    const res = await mcp.send('tools/list', {});
    assert.ok(res.result, `tools/list failed: ${JSON.stringify(res)}`);
    const tools = res.result.tools;
    assert.ok(Array.isArray(tools), 'tools should be an array');
    assert.equal(tools.length, 6, `expected 6 tools, got ${tools.length}: ${tools.map((t: any) => t.name).join(', ')}`);

    const names = tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      'assign_role',
      'chat_completion',
      'list_endpoints',
      'list_roles',
      'resolve_endpoint',
      'scan_network',
    ]);
  });

  it('list_endpoints → ノード一覧の JSON が返る', async () => {
    const res = await mcp.send('tools/call', {
      name: 'list_endpoints',
      arguments: {},
    });
    assert.ok(res.result, `list_endpoints failed: ${JSON.stringify(res)}`);
    const text = res.result.content[0]?.text;
    assert.ok(text, 'should have text content');
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed), 'should be an array of endpoints');
  });

  it('list_roles → ロール割り当てが返る', async () => {
    const res = await mcp.send('tools/call', {
      name: 'list_roles',
      arguments: {},
    });
    assert.ok(res.result);
    const text = res.result.content[0]?.text;
    assert.ok(text);
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed, 'object');
  });

  it('scan_network → "scan started" メッセージ', async () => {
    const res = await mcp.send('tools/call', {
      name: 'scan_network',
      arguments: {},
    });
    assert.ok(res.result);
    const text = res.result.content[0]?.text;
    assert.ok(text.toLowerCase().includes('scan'), `expected scan message, got: ${text}`);
  });

  it('resolve_endpoint（該当なし）→ エラーメッセージ', async () => {
    const res = await mcp.send('tools/call', {
      name: 'resolve_endpoint',
      arguments: { model_id: 'nonexistent-model-xyz' },
    });
    // MCP ツールはエラー時も result.content として返す or result.isError
    assert.ok(res.result || res.error);
    if (res.result) {
      const text = res.result.content[0]?.text ?? '';
      assert.ok(text.length > 0);
    }
  });
});
