import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';

import type { PRTeamConfig } from '@farmslot/protocol';

import { watcherClock } from '../core/watch-clock.test-support.js';
import type { ClientState } from '../server/client-state.js';

// All owning files and env are private before importing the config decision core.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'configuration-writers-')));
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
  path.join(root, 'fixture-status.json'),
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
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'fixture-status.json');
// Optional registration starts absent, as on a fresh host. Never inspect personal stores.
const privateOs = { ...os, homedir: () => path.join(root, 'external-home') };
mock.module('node:os', { defaultExport: privateOs, namedExports: privateOs });
await import('../runtime/mock-pty.test-support.js');
const config = await import('../methods/config.js');
const { getLLMConfig, setLLMConfig } = await import('../llm/config.js');
const { saveAuthProfileStore, getFarmslotStorePath, getOpenClawStorePath, loadAuthProfileStore } =
  await import('../llm/auth-store.js');
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

interface ConfigurationEvent {
  event: string;
  file: string;
}

// Rename-over can be a change or a rediscovered add, depending on native event ordering.
const replacementEvents = ['change', 'add'] as const;

function configurationWatcher(t: TestContext) {
  const clock = watcherClock(t);
  const watcher = startFileWatcher();
  const events: ConfigurationEvent[] = [];
  watcher.onFileEvent((event, file) => events.push({ event, file }));
  return {
    ...watcher,
    clock,
    async readyFor(file: string): Promise<void> {
      const probe = `${file}.watch-ready`;
      const start = events.length;
      try {
        // FSEvents can drop a write immediately after fs.watch starts. Await a receipt
        // for this ignored probe instead of assuming Chokidar readiness arms the OS.
        await clock.until(
          async () => {
            if (events.slice(start).some((item) => item.file === probe && item.event === 'raw'))
              return true;
            await writeFile(probe, 'ready');
            return false;
          },
          `Native directory observation: ${path.dirname(file)}`,
        );
      } finally {
        await rm(probe, { force: true });
      }
    },
    async observe(file: string, expectedEvents: readonly string[], write: () => Promise<unknown>) {
      const start = events.length;
      await write();
      await clock.until(
        () =>
          events
            .slice(start)
            .some((item) => item.file === file && expectedEvents.includes(item.event)),
        `${expectedEvents.join(' or ')}: ${file}`,
      );
    },
  };
}

test('registration reads refuse malformed sources without exposing secrets or losing fallback resolution', async (t) => {
  const files = [getFarmslotStorePath(), getOpenClawStorePath()];
  for (const file of files) {
    let original: Buffer | undefined;
    try {
      original = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    t.after(async () => {
      await rm(file, { recursive: true, force: true });
      if (original) await writeFile(file, original);
    });
    await mkdir(path.dirname(file), { recursive: true });
  }
  const valid = JSON.stringify({
    version: 1,
    profiles: { fixture: { type: 'api_key', provider: 'google', key: 'SECRET_CANARY' } },
  });
  await writeFile(files[0], valid);
  const listed = await llmAuthList();
  assert.equal(listed.profiles[0].profileId, 'fixture');
  assert(!JSON.stringify(listed).includes('SECRET_CANARY'));
  for (const invalid of [
    '{"SECRET_CANARY":',
    '{"version":2,"profiles":{}}',
    '{"version":1,"profiles":null}',
    '{"version":1,"profiles":[]}',
    '{"version":1,"profiles":{"bad":null}}',
    '{"version":1,"profiles":{"bad":{"provider":"google","type":["api_key"]}}}',
  ]) {
    await writeFile(files[0], invalid);
    await assert.rejects(llmAuthList, { message: 'Could not read provider registrations.' });
    assert.equal(await loadAuthProfileStore(files[0]), null);
  }
  await writeFile(files[0], valid);
  await writeFile(files[1], '{"SECRET_CANARY":');
  await assert.rejects(llmAuthList, { message: 'Could not read provider registrations.' });
  await rm(files[1]);
  assert.equal((await llmAuthList()).profiles[0].profileId, 'fixture');
  await rm(files[0]);
  await mkdir(files[0]);
  await assert.rejects(llmAuthList, { message: 'Could not read provider registrations.' });
  await rm(files[0], { recursive: true });
  assert.deepEqual((await llmAuthList()).profiles, []);
});

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

test('actual external template/project/registration file writes use the existing bounded watcher', async (t) => {
  const watcher = configurationWatcher(t);
  const { clock } = watcher;
  try {
    await watcher.ready;
    clock.flush();
    for (const [file, content] of [
      [path.join(root, 'projects/example/templates/worker/dev.md'), '# Updated worker template'],
      [projectFile, JSON.stringify({ name: 'example', default_branch: 'trunk' })],
      [path.join(root, 'home/llm-config.json'), JSON.stringify({ defaultProvider: 'google' })],
      [getFarmslotStorePath(), JSON.stringify({ version: 1, profiles: {} })],
      [poolFile, (await readFile(poolFile, 'utf8')) + '\n'],
      [getOpenClawStorePath(), JSON.stringify({ version: 1, profiles: {} })],
    ]) {
      if (file === getOpenClawStorePath()) await mkdir(path.dirname(file), { recursive: true });
      await watcher.readyFor(file);
      const before = resourceRevisions.revision(farm);
      const event = await readFile(file).then(
        () => 'change',
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return 'add';
        },
      );
      await watcher.observe(file, [event], () => writeFile(file, content));
      await clock.until(() => resourceRevisions.revision(farm) > before, path.basename(file));
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

test('an immediate atomic template replacement publishes after the earlier observation', async (t) => {
  const watcher = configurationWatcher(t);
  const { clock } = watcher;
  const file = path.join(root, 'projects/example/templates/worker/dev.md');
  const replacement = `${file}.tmp`;
  const waitForRevision = (previous: number) =>
    clock.until(
      () => resourceRevisions.revision(farm) > previous,
      'The final readable replacement must invalidate configuration',
    );
  try {
    await watcher.ready;
    clock.flush();
    await watcher.readyFor(file);
    const before = resourceRevisions.revision(farm);
    await watcher.observe(file, ['change'], () => writeFile(file, '# First observed template'));
    await waitForRevision(before);
    const first = resourceRevisions.revision(farm);
    assert.equal(
      (await config.configTemplates({ project: 'example' })).templates[0].rawMarkdown,
      '# First observed template',
    );
    await writeFile(replacement, '# Final atomic template');
    await watcher.observe(file, replacementEvents, () => rename(replacement, file));
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

test('malformed project sources fail client observations instead of returning an empty list or NOT_FOUND', async () => {
  const original = await readFile(projectFile, 'utf8');
  try {
    assert((await config.configProjects()).projects.some((item) => item.name === 'example'));
    await writeFile(projectFile, '{broken');
    await assert.rejects(config.configProjects(), SyntaxError);
    await assert.rejects(config.configProject({ project: 'example' }), SyntaxError);
  } finally {
    await writeFile(projectFile, original);
  }
  assert((await config.configProjects()).projects.some((item) => item.name === 'example'));
});

test('the selected-home observer invalidates each assessment policy on add, replacement and deletion', async (t) => {
  const watcher = configurationWatcher(t);
  const { clock } = watcher;
  const key = { family: 'assessment', scope: 'farm' } as const;
  try {
    await watcher.ready;
    clock.flush();
    for (const name of [
      'assessment-config.json',
      'assessment-suggestion-policy.json',
      'decision-advice-policy.json',
      'triage-policy.json',
    ]) {
      const file = path.join(root, 'home', name);
      await watcher.readyFor(file);
      for (const [expectedEvents, write] of [
        [['add'], () => writeFile(file, '{}')],
        [
          replacementEvents,
          async () => {
            await writeFile(`${file}.tmp`, '{"enabled":false}');
            await rename(`${file}.tmp`, file);
          },
        ],
        [['unlink'], () => rm(file)],
      ] as const) {
        const before = resourceRevisions.revision(key);
        await watcher.observe(file, expectedEvents, write);
        await clock.until(() => resourceRevisions.revision(key) > before, name);
      }
    }
  } finally {
    await watcher.close();
  }
});

test('the owning home watcher rebinds the selected triage receipt directory', async (t) => {
  const home = path.join(root, 'home');
  const file = path.join(home, 'triage-policy.json');
  const first = path.join(root, 'pilot-first');
  const second = path.join(root, 'pilot-second');
  await Promise.all([mkdir(first), mkdir(second)]);
  const writePolicy = (directory: string) =>
    writeFile(
      file,
      JSON.stringify({
        enabled: true,
        projects: ['example'],
        receiptDirectory: directory,
        maxCalls: 1,
        maxUsd: 0.01,
        price: {
          version: 1,
          provider: 'typesafe',
          model: 'jev-fixture',
          verifiedAt: new Date().toISOString(),
          source: 'fixture:selected-pilot',
          inputUsdPerMillion: 0.01,
          outputUsdPerMillion: 0,
          maxRequestTokens: 1000,
        },
        approvals: [],
      }),
    );
  await writePolicy(first);
  const watcher = configurationWatcher(t);
  const { clock } = watcher;
  const key = { family: 'assessment', scope: 'farm' } as const;
  try {
    await watcher.ready;
    clock.flush();
    await watcher.readyFor(file);
    await clock.until(() => {
      try {
        watcher.assertTriagePilotObserved(first);
        return true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'RESOURCE_OBSERVATION_UNAVAILABLE'
        )
          throw error;
        return false;
      }
    }, 'current initial triage selection readiness');
    let before = resourceRevisions.revision(key);
    await writeFile(path.join(first, 'evaluation.json'), 'current selected source');
    await clock.until(() => resourceRevisions.revision(key) > before, 'selected receipt bytes');
    await writePolicy(second);
    await clock.until(() => {
      try {
        watcher.assertTriagePilotObserved(second);
        return true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'RESOURCE_OBSERVATION_UNAVAILABLE'
        )
          throw error;
        return false;
      }
    }, 'policy-selected observation replacement');
    before = resourceRevisions.revision(key);
    await writeFile(path.join(second, 'evaluation.json'), 'new selected source');
    await clock.until(() => resourceRevisions.revision(key) > before, 'new selected receipt bytes');
    assert.throws(() => watcher.assertTriagePilotObserved(first));
  } finally {
    await watcher.close();
    await rm(file, { force: true });
    await Promise.all([rm(first, { recursive: true }), rm(second, { recursive: true })]);
  }
});

test('the actual PR rule file observer reloads replacements and refuses malformed/deleted sources until recovery', async (t) => {
  const { initPRMonitoring } = await import('../methods/pr-watch.js');
  const { initPRRules } = await import('../methods/pr-rules.js');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'pr-authorization') });
  initializeGatewayIdentity(auth, { host: '127.0.0.1' });
  const owner = auth.writer.createPrincipal(
    { type: 'person', displayName: 'Private rule reader' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const publications: unknown[] = [];
  const publish = (...args: unknown[]) => {
    publications.push(args);
  };
  const monitors = await initPRMonitoring(auth, publish, false);
  const rules = await initPRRules(auth, publish, false, monitors);
  const config: PRTeamConfig = {
    name: 'Initial team',
    account: { host: 'github.com', login: 'private-reader' },
    sources: [{ kind: 'repository', repo: 'private/repo' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    repositories: [
      { repo: 'private/repo', project: 'example', reviewProfile: 'standard', excludedLabels: [] },
    ],
    execution: {
      slotPolicy: { kind: 'exact', slotId: 'config-slot' },
      models: [{ mode: 'cold', runner: 'runner', model: 'model', effort: 'high' }],
    },
    githubTeams: [],
    notificationPrincipalIds: [],
  };
  await rules.store.saveTeam(owner.id, config);
  const file = path.join(root, '.pr-rules.json');
  const watcher = configurationWatcher(t);
  const { clock } = watcher;
  const diagnostics: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    diagnostics.push(args);
  });
  const unavailable = () => {
    try {
      rules.store.snapshot();
      return false;
    } catch (error) {
      assert.equal((error as { code: string }).code, 'SOURCE_UNAVAILABLE');
      return true;
    }
  };
  try {
    await watcher.ready;
    clock.flush();
    await watcher.readyFor(file);
    const external = rules.store.snapshot();
    external.teams[0].config.name = 'External team';
    await writeFile(`${file}.tmp`, JSON.stringify(external));
    await watcher.observe(file, replacementEvents, () => rename(`${file}.tmp`, file));
    await clock.until(
      () => rules.store.snapshot().teams[0].config.name === 'External team',
      'External rule rename must replace readable memory',
    );
    assert(publications.length > 0);
    for (const breakSource of [() => writeFile(file, '{broken'), () => rm(file)]) {
      await breakSource();
      await clock.until(unavailable, 'A broken rule source must refuse retained memory');
      await assert.rejects(rules.store.saveTeam(owner.id, config), { code: 'SOURCE_UNAVAILABLE' });
      await writeFile(file, JSON.stringify(external));
      await clock.until(
        () => !unavailable(),
        'A valid source must recover without reinitializing schedulers',
      );
      assert.equal(rules.store.snapshot().teams[0].config.name, 'External team');
    }
    assert(diagnostics.some((args) => args[0] === '[state] PR rule source reload failed:'));
  } finally {
    await watcher.close();
    rules.stop();
    monitors.stop();
  }
});
