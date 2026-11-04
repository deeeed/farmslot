import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { FleetStatus, NodeTmuxPane } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'machine-pool-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects'])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Test root\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
const base = {
  machine: 'review-node',
  host: 'localhost',
  ssh_user: 'fixture',
  os: 'linux',
  platform: 'cli',
};
writeFileSync(
  path.join(root, 'pool/review-node.json'),
  JSON.stringify({
    ...base,
    project: 'primary',
    codex_path: '/primary/codex',
    tmux_workers: { exclude: [{ session: 'private' }] },
    slots: [{ id: 'primary-1', enabled: true, repo: '/fixture/primary', session: 'primary' }],
  }),
);
writeFileSync(
  path.join(root, 'pool/canary-review-node.json'),
  JSON.stringify({
    ...base,
    project: 'canary',
    codex_path: '/canary/codex',
    slots: [{ id: 'canary-1', enabled: true, repo: '/fixture/canary', session: 'canary' }],
  }),
);
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
after(() => rmSync(root, { recursive: true, force: true }));
const { loadPoolConfig, loadPoolConfigs } = await import('./state.js');
const { buildTmuxWorkerListFromSources } = await import('../methods/tmux-workers.js');
const { loadMachinePool, loadMachineSlots } = await import('../core/config.js');
const { modelCatalogNodes } = await import('../methods/runner-models.js');

test('machine configuration uses its canonical file when the canary sorts first', async () => {
  const pool = await loadPoolConfig('review-node');
  assert.equal(pool?.project, 'primary');
  assert.deepEqual(pool?.tmuxWorkers, { exclude: [{ session: 'private' }] });
});

test('machine launch settings use the same canonical authority', async () => {
  assert.equal((await loadMachinePool('review-node')).codex_path, '/primary/codex');
});

test('machine slot discovery includes execution pools alongside the canonical pool', async () => {
  assert.deepEqual((await loadMachineSlots('review-node')).map((slot) => slot.id).sort(), [
    'canary-1',
    'primary-1',
  ]);
});

test('terminal inventory keeps machine policy when pool order is reversed', async () => {
  const pools = (await loadPoolConfigs()).reverse();
  const fleet: FleetStatus = {
    checkedAt: '2026-11-04T00:00:00Z',
    slots: [],
    summary: {
      total: 0,
      ready: 0,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
  const pane: NodeTmuxPane = {
    session: 'private',
    window: '0',
    pane: '0',
    paneId: '%1',
    target: 'private:0.0',
    command: 'zsh',
  };
  const result = await buildTmuxWorkerListFromSources({
    pools,
    fleet,
    nodeIds: ['review-node'],
    connectedNodeIds: new Set(['review-node']),
    observedAt: 1,
    requestPanes: async () => [pane],
  });
  assert.deepEqual(result.workers, []);
  assert.equal(result.hiddenWorkers, 1);
});

test('refinement resolves the machine with both pool files without opening tmux', async () => {
  const previousPath = process.env.PATH;
  const bin = path.join(root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'tmux'), "#!/bin/sh\nprintf 'fixture\\t0\\tshell\\t0\\t%%7\\n'\n", {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const { resolveTmuxSessionWorker } = await import('../refinement/session.js');
    assert.equal((await resolveTmuxSessionWorker('fixture')).nodeId, 'review-node');
    const primary = path.join(root, 'pool/review-node.json');
    const ambiguous = path.join(root, 'pool/other-review-node.json');
    renameSync(primary, ambiguous);
    try {
      await assert.rejects(resolveTmuxSessionWorker('fixture'), /ambiguous pool settings/);
    } finally {
      renameSync(ambiguous, primary);
    }
  } finally {
    process.env.PATH = previousPath;
  }
});

test('model catalogs retain execution slots when the machine settings pool has none', async () => {
  const file = path.join(root, 'pool/review-node.json');
  const original = readFileSync(file, 'utf8');
  const settings = JSON.parse(original);
  writeFileSync(file, JSON.stringify({ ...settings, slots: [] }));
  try {
    assert.deepEqual(
      (await modelCatalogNodes()).map((node) => node.machine),
      ['review-node'],
    );
  } finally {
    writeFileSync(file, original);
  }
});

test('unrelated non-object JSON does not break machine slot discovery', async (t) => {
  const file = path.join(root, 'pool/broken.json');
  t.after(() => rmSync(file, { force: true }));
  for (const invalid of ['null', '[]', '42', '"not a pool"']) {
    writeFileSync(file, invalid);
    assert.deepEqual((await loadMachineSlots('review-node')).map((slot) => slot.id).sort(), [
      'canary-1',
      'primary-1',
    ]);
  }
});
