import { WebSocketServer, WebSocket } from 'ws';
import { WsCommand, WsEvent, WsResponse } from './types.js';
import { EndpointManager } from './EndpointManager.js';

export class WsServer {
  private _wss: WebSocketServer;
  private _clients = new Set<WebSocket>();

  constructor(
    private readonly _manager: EndpointManager,
    port: number,
  ) {
    this._wss = new WebSocketServer({ port });

    // EndpointManager のプッシュイベントを全クライアントにブロードキャスト
    _manager.on('push', (msg: WsEvent) => {
      this._broadcast(msg);
    });

    this._wss.on('connection', (ws) => {
      this._clients.add(ws);

      // 接続時に現在の全ノード＋ロール一覧を送信（初期同期）
      this._send(ws, {
        event: 'scan_completed',
        data: { found: _manager.getAllNodes().length, nodes: _manager.getAllNodes() },
      });
      this._send(ws, {
        event: 'roles_changed',
        data: _manager.getRoles(),
      });

      ws.on('message', (raw) => {
        this._handleMessage(ws, raw.toString());
      });

      ws.on('close', () => {
        this._clients.delete(ws);
      });

      ws.on('error', () => {
        this._clients.delete(ws);
      });
    });

    this._wss.on('error', (err) => {
      console.error('[WsServer] error:', err.message);
    });

    console.log(`[WsServer] listening on ws://0.0.0.0:${port}`);
  }

  // ════════════════════════════════════════════════════════════
  // メッセージハンドラ
  // ════════════════════════════════════════════════════════════

  private async _handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let cmd: WsCommand;
    try {
      cmd = JSON.parse(raw) as WsCommand;
    } catch {
      return;
    }

    try {
      const data = await this._dispatch(cmd);
      this._reply(ws, cmd.id, true, data);
    } catch (err) {
      this._reply(ws, cmd.id, false, undefined, String(err));
    }
  }

  private async _dispatch(cmd: WsCommand): Promise<unknown> {
    const m = this._manager;

    switch (cmd.type) {
      case 'scan':
        // 非同期でスキャン開始。結果は push イベントで流れる。
        m.scan().catch(console.error);
        return { started: true };

      case 'list':
        return m.getAllNodes();

      case 'resolve': {
        const node = m.resolve(cmd.modelId, cmd.role);
        if (!node) throw new Error(`no available endpoint for model "${cmd.modelId}"`);
        return node;
      }

      case 'get_models': {
        const node = m.getNode(cmd.endpointId);
        if (!node) throw new Error(`unknown endpoint: ${cmd.endpointId}`);
        return { availableModels: node.availableModels, loadedModels: node.loadedModels };
      }

      case 'probe': {
        const node = await m.probeOne(cmd.endpointId);
        if (!node) throw new Error(`unknown endpoint: ${cmd.endpointId}`);
        return node;
      }

      case 'add_endpoint':
        return await m.addEndpoint(cmd.url, cmd.label);

      case 'remove_endpoint': {
        const ok = m.removeEndpoint(cmd.endpointId);
        if (!ok) throw new Error(`unknown endpoint: ${cmd.endpointId}`);
        return { removed: true };
      }

      case 'get_roles':
        return m.getRoles();

      case 'assign_role':
        m.assignRole(cmd.role, cmd.endpointId);
        return { role: cmd.role, endpointId: cmd.endpointId };

      case 'unassign_role':
        m.unassignRole(cmd.role);
        return { role: cmd.role };

      // ── 双方向同期（クライアントからの報告）──────────────
      case 'report_health':
        m.reportHealth(cmd.endpointId, cmd.state);
        return { ok: true };

      case 'report_model_loaded':
        m.reportModelLoaded(cmd.endpointId, cmd.modelId);
        return { ok: true };

      case 'report_models':
        m.reportModels(cmd.endpointId, cmd.availableModels, cmd.loadedModels);
        return { ok: true };

      default:
        throw new Error(`unknown command type`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // 送受信ユーティリティ
  // ════════════════════════════════════════════════════════════

  private _reply(ws: WebSocket, id: string, ok: boolean, data?: unknown, error?: string): void {
    const msg: WsResponse = { id, ok, data, error };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private _send(ws: WebSocket, event: WsEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private _broadcast(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this._clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  get clientCount(): number {
    return this._clients.size;
  }

  close(): void {
    this._wss.close();
  }
}
