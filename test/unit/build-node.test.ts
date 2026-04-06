import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNode, type ProbeResult } from '../../src/NetworkScanner.js';
import { NodeHealthState } from '../../src/types.js';

function makeProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    url:             overrides.url ?? 'http://192.168.1.22:1234/v1',
    reachable:       overrides.reachable ?? true,
    availableModels: overrides.availableModels ?? ['model-a'],
    loadedModels:    overrides.loadedModels ?? [],
  };
}

describe('buildNode()', () => {
  it('localhost URL → id が "local-" プレフィックス', () => {
    const probe = makeProbe({ url: 'http://127.0.0.1:1234/v1' });
    const node = buildNode(probe);
    assert.ok(node.id.startsWith('local-'));
    assert.equal(node.type, 'local');
  });

  it('localhost の別表記でも local', () => {
    const probe = makeProbe({ url: 'http://localhost:1234/v1' });
    const node = buildNode(probe);
    assert.ok(node.id.startsWith('local-'));
  });

  it('192.168.x.x → id が "local-" プレフィックス', () => {
    const probe = makeProbe({ url: 'http://192.168.1.22:1234/v1' });
    const node = buildNode(probe);
    assert.ok(node.id.startsWith('local-'));
  });

  it('10.x.x.x → id が "local-" プレフィックス', () => {
    const probe = makeProbe({ url: 'http://10.0.0.5:1234/v1' });
    const node = buildNode(probe);
    assert.ok(node.id.startsWith('local-'));
  });

  it('172.16-31.x.x → id が "local-" プレフィックス', () => {
    const probe = makeProbe({ url: 'http://172.16.0.1:1234/v1' });
    const node = buildNode(probe);
    assert.ok(node.id.startsWith('local-'));
  });

  it('外部 IP → id が "remote-" プレフィックス', () => {
    const probe = makeProbe({ url: 'http://8.8.8.8:1234/v1' });
    const node = buildNode(probe);
    assert.ok(node.id.startsWith('remote-'));
  });

  it('モデル情報が正しく転写される', () => {
    const probe = makeProbe({
      availableModels: ['model-a', 'model-b'],
      loadedModels: ['model-a'],
    });
    const node = buildNode(probe);
    assert.deepEqual(node.availableModels, ['model-a', 'model-b']);
    assert.deepEqual(node.loadedModels, ['model-a']);
  });

  it('Online 状態で生成される', () => {
    const node = buildNode(makeProbe());
    assert.equal(node.healthStatus, NodeHealthState.Online);
  });

  it('providerType を指定できる', () => {
    const node = buildNode(makeProbe(), 'ollama');
    assert.equal(node.providerType, 'ollama');
  });

  it('providerUrl が保存される', () => {
    const probe = makeProbe({ url: 'http://192.168.1.22:1234/v1' });
    const node = buildNode(probe);
    assert.equal(node.providerUrl, 'http://192.168.1.22:1234/v1');
  });
});
