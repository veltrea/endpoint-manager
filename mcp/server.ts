/*---------------------------------------------------------------------------------------------
 *  Endpoint Manager MCP Server
 *  Thin WebSocket client that exposes Endpoint Manager as MCP tools.
 *  Runs as a stdio MCP server for AI agents (Claude Code, Gemini CLI, Cursor, etc.)
 *
 *  設計制約:
 *  - MCP サーバーは WS クライアントとしてのみ接続（GUI を開かない）
 *  - 複数の MCP サーバーが同時接続しても問題ない
 *  - バックエンド未起動時は detached spawn で自動起動（fire-and-forget）
 *--------------------------------------------------------------------------------------------*/
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import * as net from 'node:net';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const WS_PORT = Number(process.env.EM_WS_PORT) || 3797;
const WS_URL = process.env.EM_WS_URL ?? `ws://127.0.0.1:${WS_PORT}`;

// ════════════════════════════════════════════════════════════════
// バックエンド自動起動（fire-and-forget）
// ════════════════════════════════════════════════════════════════

/** ポートが listen 中か即座に確認する */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

/** Node.js パスを検出する */
function findNodePath(): string {
  const home = process.env.HOME ?? '';

  // nvm v22
  const nvmPath = join(home, '.nvm/versions/node/v22.17.0/bin/node');
  if (existsSync(nvmPath)) return nvmPath;

  // Homebrew (Apple Silicon)
  if (existsSync('/opt/homebrew/bin/node')) return '/opt/homebrew/bin/node';

  // Homebrew (Intel)
  if (existsSync('/usr/local/bin/node')) return '/usr/local/bin/node';

  // PATH にある node を使う
  return 'node';
}

/** バックエンドを detached spawn で起動（MCP プロセスから完全切り離し） */
function launchBackendDetached(): void {
  const nodePath = findNodePath();
  const logPath = join(PROJECT_ROOT, 'endpoint-manager.log');

  const logFd = openSync(logPath, 'a');

  const child = spawn(nodePath, ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PATH: `${dirname(nodePath)}:${process.env.PATH}` },
  });

  child.unref();
  console.error(`[mcp] Backend launched (PID: ${child.pid}) → ${logPath}`);
}

/** 必要ならバックエンドを起動する */
async function ensureBackendRunning(): Promise<void> {
  if (await isPortListening(WS_PORT)) {
    console.error(`[mcp] Backend already running on port ${WS_PORT}`);
    return;
  }

  console.error(`[mcp] Backend not running. Launching...`);
  launchBackendDetached();
  // fire-and-forget: 起動を待たない。WS 接続はツール呼び出し時にリトライする。
}

// ════════════════════════════════════════════════════════════════
// WebSocket RPC クライアント
// ════════════════════════════════════════════════════════════════

class EndpointManagerClient {
  private _ws: WebSocket | null = null;
  private _pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private _nextId = 0;
  private _connected = false;

  async connect(): Promise<void> {
    if (this._connected && this._ws?.readyState === WebSocket.OPEN) return;

    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(WS_URL);

      const timeout = setTimeout(() => {
        this._ws?.terminate();
        reject(new Error(`Connection timeout to ${WS_URL}`));
      }, 5000);

      this._ws.on('open', () => {
        clearTimeout(timeout);
        this._connected = true;
        resolve();
      });

      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // コマンドレスポンス（id あり）
          if ('id' in msg && this._pending.has(msg.id)) {
            const p = this._pending.get(msg.id)!;
            this._pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.data);
            else p.reject(new Error(msg.error ?? 'Unknown error'));
          }
          // プッシュイベント（id なし）は無視（MCP は request-response 型）
        } catch { /* ignore non-JSON */ }
      });

      this._ws.on('close', () => {
        this._connected = false;
        for (const [, p] of this._pending) p.reject(new Error('WebSocket closed'));
        this._pending.clear();
      });

      this._ws.on('error', (err) => {
        if (!this._connected) { clearTimeout(timeout); reject(err); }
      });
    });
  }

  /** 接続を保証してから RPC を送る */
  async rpc(type: string, params?: Record<string, unknown>): Promise<any> {
    // 接続されていなければ接続を試行（バックエンド起動直後のリトライ含む）
    if (!this._connected || this._ws?.readyState !== WebSocket.OPEN) {
      for (let i = 0; i < 5; i++) {
        try {
          await this.connect();
          break;
        } catch {
          if (i < 4) await new Promise((r) => setTimeout(r, 1000));
          else throw new Error(`Cannot connect to Endpoint Manager at ${WS_URL}. Is the backend running?`);
        }
      }
    }

    const id = `mcp-${this._nextId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${type}`));
      }, 10000);

      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this._ws!.send(JSON.stringify({ id, type, ...params }));
    });
  }
}

// ════════════════════════════════════════════════════════════════
// HTTP 推論呼び出し（chat_completion 用）
// ════════════════════════════════════════════════════════════════

interface ChatMessage {
  role: string;
  content: string;
}

async function fetchChatCompletion(
  providerUrl: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  const url = `${providerUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = http.request(parsedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c: Buffer) => errBody += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
        return;
      }

      let fullText = '';
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) fullText += content;
          } catch { /* partial JSON, skip */ }
        }
      });
      res.on('end', () => resolve(fullText));
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════
// MCP Server 定義
// ════════════════════════════════════════════════════════════════

const client = new EndpointManagerClient();
const server = new McpServer({
  name: 'endpoint-manager',
  version: '0.1.0',
});

// ── resolve_endpoint ─────────────────────────────────────────

server.tool(
  'resolve_endpoint',
  'Resolve the best AI inference endpoint for a given role and/or model. Returns the endpoint URL and node details.',
  {
    role: z.string().optional().describe('Role name (e.g. "coder", "planner", "fast")'),
    model_id: z.string().optional().describe('Model ID to look for (empty string = any model)'),
  },
  async ({ role, model_id }) => {
    const result = await client.rpc('resolve', { modelId: model_id ?? '', role });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// ── list_endpoints ───────────────────────────────────────────

server.tool(
  'list_endpoints',
  'List all known AI inference endpoints with their health status, models, and metadata.',
  {},
  async () => {
    const result = await client.rpc('list');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// ── list_roles ───────────────────────────────────────────────

server.tool(
  'list_roles',
  'List all role assignments (role name → endpoint ID mapping).',
  {},
  async () => {
    const result = await client.rpc('get_roles');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// ── scan_network ─────────────────────────────────────────────

server.tool(
  'scan_network',
  'Trigger a network scan to discover LM Studio instances on the local network. Results arrive asynchronously.',
  {},
  async () => {
    await client.rpc('scan');
    return {
      content: [{
        type: 'text',
        text: 'Network scan started. Use list_endpoints after a few seconds to see results.',
      }],
    };
  },
);

// ── assign_role ──────────────────────────────────────────────

server.tool(
  'assign_role',
  'Assign a role to a specific endpoint. Use list_endpoints to find endpoint IDs.',
  {
    role: z.string().describe('Role name (e.g. "coder", "planner", "fast")'),
    endpoint_id: z.string().describe('Endpoint ID (e.g. "local-http://192.168.1.22:1234/v1")'),
  },
  async ({ role, endpoint_id }) => {
    await client.rpc('assign_role', { role, endpointId: endpoint_id });
    return {
      content: [{
        type: 'text',
        text: `Role "${role}" assigned to ${endpoint_id}`,
      }],
    };
  },
);

// ── chat_completion ──────────────────────────────────────────

server.tool(
  'chat_completion',
  'Send a chat completion request to a local AI model via Endpoint Manager. Resolves the best endpoint automatically based on role, then calls the OpenAI-compatible API.',
  {
    messages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']).describe('Message role'),
      content: z.string().describe('Message content'),
    })).describe('Chat messages array'),
    role: z.string().optional().describe('Endpoint role to use (e.g. "coder", "planner", "fast")'),
    model_id: z.string().optional().describe('Specific model ID (empty = use whatever is loaded)'),
    max_tokens: z.number().optional().describe('Maximum tokens to generate (default: 2048)'),
  },
  async ({ messages, role, model_id, max_tokens }) => {
    // 1. エンドポイントを解決
    let endpoint: any;
    try {
      endpoint = await client.rpc('resolve', { modelId: model_id ?? '', role });
    } catch (e: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to resolve endpoint: ${e.message}. No online AI endpoints available.`,
        }],
      };
    }

    // 2. 使用するモデルを決定
    const model = model_id
      || endpoint.loadedModels?.[0]
      || endpoint.availableModels?.[0]
      || 'default';

    // 3. 推論呼び出し
    try {
      const response = await fetchChatCompletion(
        endpoint.providerUrl,
        model,
        messages,
        max_tokens ?? 2048,
      );

      return {
        content: [{
          type: 'text',
          text: response || '(empty response)',
        }],
      };
    } catch (e: any) {
      // エラー時はサービスにヘルス状態を報告
      try {
        const state = e.message?.includes('429') ? 'RateLimited' : 'Offline';
        await client.rpc('report_health', { endpointId: endpoint.id, state });
      } catch { /* best effort */ }

      return {
        content: [{
          type: 'text',
          text: `Inference failed (${endpoint.providerUrl}): ${e.message}`,
        }],
      };
    }
  },
);

// ════════════════════════════════════════════════════════════════
// 起動
// ════════════════════════════════════════════════════════════════

async function main() {
  // バックエンドが起動していなければ fire-and-forget で起動
  await ensureBackendRunning();

  // WS 接続を試行（失敗しても MCP サーバーは起動する）
  try {
    await client.connect();
    console.error(`[mcp] Connected to Endpoint Manager at ${WS_URL}`);
  } catch {
    console.error(`[mcp] Warning: Could not connect to Endpoint Manager at ${WS_URL}`);
    console.error(`[mcp] Will retry on first tool call.`);
  }

  // MCP サーバーを stdio で起動
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] MCP server running on stdio');
}

main().catch((err) => { console.error('[mcp] Fatal:', err); process.exit(1); });
