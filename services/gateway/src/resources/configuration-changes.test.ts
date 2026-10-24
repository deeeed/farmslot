import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ClientState } from '../server/client-state.js';

// All owning files and env are private before importing the config decision core.
const root = mkdtempSync(path.join(os.tmpdir(), 'configuration-writers-'));
for (const dir of [
  'scripts',
  'services/gateway',
  'pool',
  'projects/example/templates/worker',
  'home',
])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Private fixture');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
const poolFile = path.join(root, 'pool/fixture.json');
const projectFile = path.join(root, 'projects/example/project.json');
writeFileSync(projectFile, JSON.stringify({ name: 'example', default_branch: 'main' }));
writeFileSync(
  poolFile,
  JSON.stringify({
    schema_version: 2,
    machine: 'config-machine',
    project: 'example',
    platform: 'cli',
    os: 'darwin',
    host: 'localhost',
    slots: [{ id: 'config-slot', repo: root, session: 'config-slot', enabled: true }],
  }),
);
writeFileSync(
  path.join(root, '.farm-status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [
      {
        slot: 'config-slot',
        machine: 'config-machine',
        project: 'example',
        lifecycle: 'ready',
        enabled: true,
        health: {},
      },
    ],
    summary: {},
    machines: [],
  }),
);
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
const config = await import('../methods/config.js');
const { getLLMConfig, setLLMConfig } = await import('../llm/config.js');
const { saveAuthProfileStore, getFarmslotStorePath } = await import('../llm/auth-store.js');
const { llmAuthList } = await import('../methods/llm-auth.js');
const { startFileWatcher, loadProjectConfig } = await import('../fleet/state.js');
const { resourceRevisions } = await import('./revisions.js');
const { canReadResourceKey } = await import('./authorization.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const farm = { family: 'configuration', scope: 'farm' } as const;
const project = { ...farm, project: 'example' };

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function advances(write: () => Promise<unknown> | unknown): Promise<void> {
  const before = resourceRevisions.revision(farm);
  await write();
  assert(
    resourceRevisions.revision(farm) > before,
    'The owning writer must publish after its commit',
  );
}

test('owning project/pool/slot/provider/registration writers publish readable configuration changes', async () => {
  await advances(() =>
    config.configProjectBacklogUpdate({
      project: 'example',
      backlog: { autoDispatch: { enabled: false } },
    }),
  );
  assert.equal(
    (await config.configProject({ project: 'example' })).project.backlog?.autoDispatch?.enabled,
    false,
  );
  const beforeProject = resourceRevisions.revision(project);
  await advances(() =>
    config.configProjectAutoRecoveryUpdate({ project: 'example', autoRecovery: { enabled: true } }),
  );
  assert(resourceRevisions.revision(project) > beforeProject);
  assert.equal(
    (await config.configProject({ project: 'example' })).project.autoRecovery?.enabled,
    true,
  );
  await advances(() =>
    config.configSlotUpdate({ slotId: 'config-slot', update: { enabled: false } }),
  );
  assert.equal(
    (await config.configPool({ machine: 'config-machine' })).pool.slots[0].enabled,
    false,
  );
  const raw = await readFile(poolFile, 'utf8');
  await advances(() => config.configPoolUpdate({ machine: 'config-machine', content: raw }));
  assert.equal((await config.configPoolRaw({ machine: 'config-machine' })).raw, raw);
  await advances(() => setLLMConfig({ defaultProvider: 'anthropic' }));
  assert.equal(getLLMConfig().defaultProvider, 'anthropic');
  await advances(() =>
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          private: { type: 'api_key', provider: 'anthropic', key: 'NEVER_IN_QUERY_OR_EVENT' },
        },
      },
      getFarmslotStorePath(),
    ),
  );
  const listed = await llmAuthList();
  assert.equal(listed.profiles[0].profileId, 'private');
  assert(!JSON.stringify(listed).includes('NEVER_IN_QUERY_OR_EVENT'));
  await advances(() => saveAuthProfileStore({ version: 1, profiles: {} }, getFarmslotStorePath()));
  assert.equal((await llmAuthList()).profiles.length, 0);
});

test('actual external template/project/registration file writes use the existing bounded watcher', async () => {
  const watcher = startFileWatcher();
  try {
    await watcher.ready;
    for (const [file, content] of [
      [path.join(root, 'projects/example/templates/worker/dev.md'), '# Updated worker template'],
      [projectFile, JSON.stringify({ name: 'example', default_branch: 'trunk' })],
      [path.join(root, 'home/llm-config.json'), JSON.stringify({ defaultProvider: 'google' })],
      [getFarmslotStorePath(), JSON.stringify({ version: 1, profiles: {} })],
      [poolFile, (await readFile(poolFile, 'utf8')) + '\n'],
    ]) {
      const before = resourceRevisions.revision(farm);
      await writeFile(file, content);
      const deadline = Date.now() + 1500;
      while (resourceRevisions.revision(farm) <= before && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(resourceRevisions.revision(farm) > before, path.basename(file));
    }
    // Stop the existing pool health debounce before performing further filesystem assertions.
    await watcher.close();
    assert.equal(
      getLLMConfig().defaultProvider,
      'google',
      'External config invalidates the owning read cache before publication',
    );
    assert.equal(
      (await config.configProject({ project: 'example' })).project.defaultBranch,
      'trunk',
    );
    assert.equal(
      (await config.configTemplates({ project: 'example' })).templates[0].rawMarkdown,
      '# Updated worker template',
    );
  } finally {
    await watcher.close();
  }
});

test('an immediate atomic template replacement publishes after the earlier observation', async () => {
  const watcher = startFileWatcher();
  const file = path.join(root, 'projects/example/templates/worker/dev.md');
  const replacement = `${file}.tmp`;
  const waitForRevision = async (previous: number) => {
    const deadline = Date.now() + 1500;
    while (resourceRevisions.revision(farm) <= previous && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert(
      resourceRevisions.revision(farm) > previous,
      'The final readable replacement must invalidate configuration',
    );
  };
  try {
    await watcher.ready;
    const before = resourceRevisions.revision(farm);
    await writeFile(file, '# First observed template');
    await waitForRevision(before);
    const first = resourceRevisions.revision(farm);
    assert.equal(
      (await config.configTemplates({ project: 'example' })).templates[0].rawMarkdown,
      '# First observed template',
    );
    await writeFile(replacement, '# Final atomic template');
    await rename(replacement, file);
    await waitForRevision(first);
    assert.equal(
      (await config.configTemplates({ project: 'example' })).templates[0].rawMarkdown,
      '# Final atomic template',
    );
  } finally {
    await watcher.close();
    await rm(replacement, { force: true });
  }
});

test('missing authorized configuration details return eviction codes and refused writes do not publish', async () => {
  await assert.rejects(config.configProject({ project: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(config.configPool({ machine: 'missing' }), { code: 'NOT_FOUND' });
  const before = resourceRevisions.revision(farm);
  await assert.rejects(
    config.configPoolUpdate({ machine: 'config-machine', content: '{}' }),
    /mismatch/,
  );
  assert.equal(resourceRevisions.revision(farm), before);
});

test('configuration notifications use the same admin read authorization, including revocation', () => {
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'authorization') });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const principal = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Configuration reader' },
    [{ role: 'operator', scope: { kind: 'global' } }],
  );
  const issued = runtime.writer.issueCredential(principal.id, 'configuration-test');
  const grant = runtime.writer.exchangePersonCredential(issued.secret, {
    deviceName: 'Private test',
    deviceKind: 'cli',
  });
  const resolved = runtime.resolver.resolveSecret(grant.accessToken, 'token');
  assert(resolved.ok && resolved.authentication);
  const state = {
    authenticated: true,
    clientKind: 'ui',
    authentication: resolved.authentication,
  } as ClientState;
  assert.equal(canReadResourceKey(runtime, state, farm), false);
  runtime.writer.grantRole(principal.id, 'admin', { kind: 'global' });
  assert.equal(canReadResourceKey(runtime, state, farm), true);
  assert.equal(canReadResourceKey(runtime, state, project), true);
  runtime.writer.revokeRole(principal.id, 'admin', { kind: 'global' });
  assert.equal(canReadResourceKey(runtime, state, farm), false);
  assert.equal(canReadResourceKey(runtime, state, project), false);
});

test('persisted project RPCs redact webhook credentials without changing the gateway webhook source', async () => {
  const original = await readFile(projectFile, 'utf8');
  try {
    await writeFile(
      projectFile,
      JSON.stringify({
        name: 'example',
        default_branch: 'trunk',
        webhooks: {
          github_secret: 'PRIVATE_GITHUB_HMAC',
          jira_secret: 'PRIVATE_JIRA_TOKEN',
          auto_dispatch: false,
        },
      }),
    );
    const list = await config.configProjects();
    const detail = await config.configProject({ project: 'example' });
    for (const reply of [list, detail]) {
      assert(!JSON.stringify(reply).includes('PRIVATE_GITHUB_HMAC'));
      assert(!JSON.stringify(reply).includes('PRIVATE_JIRA_TOKEN'));
    }
    assert.equal(detail.project.webhooks?.auto_dispatch, false);
    assert.equal(
      (await loadProjectConfig('example'))?.webhooks?.github_secret,
      'PRIVATE_GITHUB_HMAC',
    );
    assert.equal((await loadProjectConfig('example'))?.webhooks?.jira_secret, 'PRIVATE_JIRA_TOKEN');
  } finally {
    await writeFile(projectFile, original);
  }
});
