import { IAIProviderNode, NodeHealthState, ProviderType } from './types.js';

const LM_STUDIO_PORT = 1234;
const PROBE_TIMEOUT_MS = 3000;
const SUBNET_TIMEOUT_MS = 8000;

// スキャン対象のサブネット（x.x.x.1 〜 x.x.x.254）
const SCAN_SUBNETS = [
  '192.168.1',
  '192.168.0',
  '10.0.0',
  '172.16.0',
];

export interface ProbeResult {
  url:             string;
  reachable:       boolean;
  availableModels: string[];
  loadedModels:    string[];
}

// ── 単一エンドポイントのプローブ ────────────────────────────
export async function probeEndpoint(
  baseUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ProbeResult> {
  const normalized = baseUrl.replace(/\/$/, '');
  const result: ProbeResult = {
    url: normalized,
    reachable: false,
    availableModels: [],
    loadedModels: [],
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

    const res = await fetcher(`${normalized}/models`, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) return result;

    const json = await res.json() as { data?: Array<{ id: string }> };
    result.reachable = true;
    result.availableModels = (json.data ?? []).map((m) => m.id);
  } catch {
    return result;
  }

  // LM Studio ネイティブ API でロード済みモデルを取得
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

    // providerUrl は /v1 付きのケースもあるので、ベースホストを取り出す
    const hostBase = normalized.replace(/\/v1$/, '');
    const res = await fetcher(`${hostBase}/api/v0/models`, { signal: ctrl.signal });
    clearTimeout(timer);

    if (res.ok) {
      const json = await res.json() as Array<{ id: string; state?: string }>;
      result.loadedModels = json
        .filter((m) => m.state === 'loaded')
        .map((m) => m.id);
    }
  } catch {
    // ネイティブ API が無くても問題なし
  }

  return result;
}

// ── ノードオブジェクトを生成 ─────────────────────────────────
export function buildNode(probe: ProbeResult, providerType: ProviderType = 'lmstudio'): IAIProviderNode {
  const isLocal =
    probe.url.includes('127.0.0.1') ||
    probe.url.includes('localhost') ||
    probe.url.match(/192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./) !== null;

  return {
    id:              `${isLocal ? 'local' : 'remote'}-${probe.url}`,
    type:            isLocal ? 'local' : 'local', // ローカルネットワーク上はすべて 'local'
    providerType,
    providerUrl:     probe.url,
    availableModels: probe.availableModels,
    loadedModels:    probe.loadedModels,
    healthStatus:    NodeHealthState.Online,
    lastSeenAt:      Date.now(),
  };
}

// ── サブネット全体をスキャン ──────────────────────────────────
async function scanSubnet(subnet: string): Promise<IAIProviderNode[]> {
  const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

  const results = await Promise.allSettled(
    hosts.map((host) =>
      Promise.race([
        probeEndpoint(`http://${host}:${LM_STUDIO_PORT}/v1`),
        new Promise<ProbeResult>((resolve) =>
          setTimeout(
            () => resolve({ url: `http://${host}:${LM_STUDIO_PORT}/v1`, reachable: false, availableModels: [], loadedModels: [] }),
            SUBNET_TIMEOUT_MS,
          ),
        ),
      ]),
    ),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<ProbeResult> => r.status === 'fulfilled' && r.value.reachable)
    .map((r) => buildNode(r.value, 'remote_lmstudio'));
}

// ── ネットワーク全体スキャン（全サブネット並列）──────────────
export async function scanNetwork(
  onFound?: (node: IAIProviderNode) => void,
): Promise<IAIProviderNode[]> {
  // ローカルホストは常にチェック
  const localhostProbe = await probeEndpoint(`http://127.0.0.1:${LM_STUDIO_PORT}/v1`);
  const found: IAIProviderNode[] = [];

  if (localhostProbe.reachable) {
    const node = buildNode(localhostProbe, 'local_lmstudio');
    found.push(node);
    onFound?.(node);
  }

  // 各サブネットを並列スキャン
  const subnetResults = await Promise.allSettled(
    SCAN_SUBNETS.map((subnet) => scanSubnet(subnet)),
  );

  for (const result of subnetResults) {
    if (result.status === 'fulfilled') {
      for (const node of result.value) {
        // ローカルホストの重複を除外
        if (!found.some((n) => n.providerUrl === node.providerUrl)) {
          found.push(node);
          onFound?.(node);
        }
      }
    }
  }

  return found;
}
