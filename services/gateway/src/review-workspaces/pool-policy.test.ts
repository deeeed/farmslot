import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { PRWorkspaceExecutionProfile } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'workspace-pool-policy-'));
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects', 'home', 'bin'])
  mkdirSync(path.join(root, directory), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_HOME: path.join(root, 'home'),
  PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
});
after(() => rmSync(root, { recursive: true, force: true }));
const { bindPRExecutionProfilesToPool } = await import('./pool-policy.js');
const portable: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool' },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};

test('empty configured registry refuses portable workspace admission', async () => {
  await assert.rejects(bindPRExecutionProfilesToPool([portable]), {
    code: 'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
    message: /no machines/,
  });
});

test('each admission binds the current registry while explicit and model lists only narrow it', async (t) => {
  const file = path.join(root, 'pool/configured.json');
  const configure = (machine: string) =>
    writeFileSync(file, JSON.stringify({ machine, host: 'localhost', slots: [] }));
  t.after(() => rmSync(file));
  configure('first');
  const [first] = await bindPRExecutionProfilesToPool([portable]);
  assert.deepEqual(first.workspacePolicy, { kind: 'pool', allowedMachines: ['first'] });
  assert.deepEqual(first.models, portable.models);
  configure('second');
  const [second] = await bindPRExecutionProfilesToPool([portable]);
  assert.deepEqual(second.workspacePolicy, { kind: 'pool', allowedMachines: ['second'] });
  const explicit = {
    ...portable,
    workspacePolicy: { kind: 'pool' as const, allowedMachines: ['first'] },
  };
  await assert.rejects(bindPRExecutionProfilesToPool([portable, explicit]), /no machines/);
  await assert.rejects(
    bindPRExecutionProfilesToPool([
      { ...portable, models: [{ ...portable.models[0], allowedMachines: ['first'] }] },
    ]),
    /models have no machines/,
  );
  assert.deepEqual(portable.workspacePolicy, { kind: 'pool' });
});
