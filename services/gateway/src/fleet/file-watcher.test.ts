import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { ResourceKey } from '@farmslot/protocol/client-cache';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-file-watcher-')));
const home = path.join(root, 'home');
const pool = path.join(root, 'pool');
const projects = path.join(root, 'projects');
const registration = path.join(home, '.openclaw/agents/main/agent');
const statusFile = path.join(root, 'private-status.json');
const rulesFile = path.join(root, '.pr-rules.json');
const poolFile = path.join(pool, 'watcher.json');
const registrationFile = path.join(registration, 'auth-profiles.json');
const projectFile = path.join(projects, 'example', 'project.json');

test.after(() => rmSync(root, { recursive: true, force: true }));

for (const directory of [
  'scripts',
  'services/gateway',
  pool,
  registration,
  path.dirname(projectFile),
])
  mkdirSync(path.resolve(root, directory), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Private fleet watcher fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(statusFile, '{"slots":[]}');

Object.assign(process.env, {
  HOME: home,
  FARMSLOT_HOME: home,
  FARMSLOT_ROOT: root,
  FARMSLOT_POOL_DIR: pool,
  FARMSLOT_PROJECTS_DIR: projects,
  FARMSLOT_TEST_STATUS_FILE: statusFile,
  NODE_TEST_CONTEXT: '1',
});

class TestWatcher extends EventEmitter {
  async close(): Promise<void> {
    this.removeAllListeners();
  }
}

const watchers = new Map<string, TestWatcher[]>();
mock.module('chokidar', {
  namedExports: {
    watch(file: string | string[]) {
      const watcher = new TestWatcher();
      const directory = Array.isArray(file) ? file[0] : file;
      const owners = watchers.get(directory) ?? [];
      owners.push(watcher);
      watchers.set(directory, owners);
      return watcher;
    },
  },
});
const reloads = new EventEmitter();
const reloadPRRulesFromFile = mock.fn(async () => {
  reloads.emit('reloaded');
});
mock.module('../methods/pr-rules.js', { namedExports: { reloadPRRulesFromFile } });

const { NATIVE_POOL_CHANGE_COALESCE_MS, startFileWatcher } = await import('./state.js');
const { resourceRevisions } = await import('../resources/revisions.js');

const configuration = { family: 'configuration', scope: 'farm' } as const;
const capabilities = { family: 'capabilities' } as const;
const workers = { family: 'workers', scope: 'farm' } as const;

function raw(directory: string, file: string, event = 'change', owner = 0): void {
  watchers.get(directory)![owner].emit('raw', event, path.basename(file), {
    watchedPath: path.dirname(file),
  });
}

function all(directory: string, file: string, event = 'change', owner = 0): void {
  watchers.get(directory)![owner].emit('all', event, file);
}

test('fleet watcher coalesces raw and all callbacks and delivers rapid distinct edits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setTimer = t.mock.method(globalThis, 'setTimeout');
  const clearTimer = t.mock.method(globalThis, 'clearTimeout');
  const watcher = startFileWatcher();
  try {
    for (const owner of [...watchers.values()].flat()) owner.emit('ready');
    await watcher.ready;
    const revisions: ResourceKey[] = [];
    t.mock.method(resourceRevisions, 'advance', (key: ResourceKey) => revisions.push(key));

    writeFileSync(rulesFile, '{"edit":1}');
    const firstReload = once(reloads, 'reloaded');
    raw(root, rulesFile);
    raw(root, rulesFile);
    all(root, rulesFile);
    await firstReload;
    await setImmediate();
    assert.equal(reloadPRRulesFromFile.mock.callCount(), 1);

    writeFileSync(rulesFile, '{"edit":22}');
    const secondReload = once(reloads, 'reloaded');
    all(root, rulesFile);
    raw(root, rulesFile);
    await secondReload;
    await setImmediate();
    assert.equal(reloadPRRulesFromFile.mock.callCount(), 2);

    writeFileSync(registrationFile, '{"edit":1}');
    raw(registration, registrationFile);
    raw(registration, registrationFile);
    all(registration, registrationFile);
    all(projects, registrationFile);
    assert.deepEqual(revisions.splice(0), [configuration]);

    writeFileSync(`${registrationFile}.tmp`, '{"edit":1}');
    renameSync(`${registrationFile}.tmp`, registrationFile);
    all(projects, registrationFile);
    raw(registration, registrationFile);
    assert.deepEqual(revisions.splice(0), [configuration]);

    writeFileSync(poolFile, '{"edit":1}');
    raw(pool, poolFile);
    assert.deepEqual(revisions.splice(0), [configuration, capabilities, workers]);
    raw(pool, poolFile);
    all(pool, poolFile);
    assert.deepEqual(revisions.splice(0), []);

    rmSync(poolFile);
    raw(pool, poolFile, 'rename');
    assert.deepEqual(revisions.splice(0), [configuration, capabilities, workers]);
    t.mock.timers.tick(104);
    all(pool, poolFile, 'unlink');
    assert.deepEqual(revisions.splice(0), []);

    writeFileSync(poolFile, '{"edit":1}');
    all(pool, poolFile, 'add');
    raw(pool, poolFile, 'rename');
    assert.deepEqual(revisions.splice(0), [configuration, capabilities, workers]);

    all(projects, projectFile);
    assert.deepEqual(revisions.splice(0), [
      configuration,
      { ...configuration, project: 'example' },
      capabilities,
      workers,
    ]);
  } finally {
    await watcher.close();
    watchers.clear();
  }
  const cleared = new Set(clearTimer.mock.calls.map(({ arguments: [timer] }) => timer));
  const coalescing = setTimer.mock.calls.filter(
    ({ arguments: [, delay] }) => delay === NATIVE_POOL_CHANGE_COALESCE_MS,
  );
  assert(coalescing.length > 0);
  for (const { result } of coalescing) assert(cleared.has(result));
});

test('overlapping pool and PR-rule watchers each deliver the same edit in either order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  process.env.FARMSLOT_POOL_DIR = root;
  t.after(() => {
    process.env.FARMSLOT_POOL_DIR = pool;
  });
  const watcher = startFileWatcher();
  try {
    for (const owner of [...watchers.values()].flat()) owner.emit('ready');
    await watcher.ready;
    assert.equal(watchers.get(root)?.length, 2);

    const revisions: ResourceKey[] = [];
    t.mock.method(resourceRevisions, 'advance', (key: ResourceKey) => revisions.push(key));
    const deliveries = [];
    for (const [first, second] of [
      [0, 1],
      [1, 0],
    ]) {
      writeFileSync(rulesFile, ' '.repeat(first) + JSON.stringify({ first }));
      const previousReloads = reloadPRRulesFromFile.mock.callCount();
      raw(root, rulesFile, 'change', first);
      raw(root, rulesFile, 'change', second);
      all(root, rulesFile, 'change', first);
      all(root, rulesFile, 'change', second);
      await setImmediate();
      deliveries.push({
        reloads: reloadPRRulesFromFile.mock.callCount() - previousReloads,
        revisions: revisions.splice(0),
      });
    }
    assert.deepEqual(deliveries, [
      { reloads: 1, revisions: [configuration, capabilities, workers] },
      { reloads: 1, revisions: [configuration, capabilities, workers] },
    ]);
  } finally {
    await watcher.close();
    watchers.clear();
  }
});
