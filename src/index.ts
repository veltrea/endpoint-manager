import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EndpointStore } from './EndpointStore.js';
import { EndpointManager } from './EndpointManager.js';
import { WsServer } from './WsServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WS_PORT   = Number(process.env.EM_WS_PORT)   || 3797;
const HTTP_PORT = Number(process.env.EM_HTTP_PORT)  || 3798;
const STORE_PATH = process.env.EM_STORE_PATH
  || join(process.env.HOME ?? '.', '.config', 'endpoint-manager', 'store.json');

// ── コアサービスを初期化 ────────────────────────────────────
const store   = new EndpointStore(STORE_PATH);
const manager = new EndpointManager(store);
const wsServer = new WsServer(manager, WS_PORT);

// ── GUI を提供する HTTP サーバー ────────────────────────────
const guiPath = join(__dirname, 'gui', 'index.html');

const httpServer = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      // WS ポートを HTML に埋め込んで返す
      let html = readFileSync(guiPath, 'utf-8');
      html = html.replace(`{{WS_PORT}}`, String(WS_PORT));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('GUI not found');
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP]  GUI → http://0.0.0.0:${HTTP_PORT}`);
});

// ── 起動時に自動スキャン ────────────────────────────────────
console.log('[Manager] 起動時スキャン開始...');
manager.scan().then((nodes) => {
  console.log(`[Manager] スキャン完了: ${nodes.length} ノード発見`);
}).catch(console.error);

// ── シャットダウン処理 ──────────────────────────────────────
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\n[Manager] シャットダウン中...');
  wsServer.close();
  httpServer.close(() => process.exit(0));
}
