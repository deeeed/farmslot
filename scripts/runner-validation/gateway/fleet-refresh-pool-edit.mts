#!/usr/bin/env tsx
// Live proof (F306) that pool edits reach fleet.status. macpro-audiolab-1 read with no resources:
// a refresh read its pool mid-write, and a later edit made while a refresh ran was absorbed by it.
//
// An isolated gateway (own pool, projects, runs and home) watches one local slot. A `git` fixture
// on its PATH waits while a marker exists, which keeps a refresh's slot probe running. Two checks:
// 1. During a held refresh, the pool gains a resource (atomic write). With the hold released, the
//    follow-up refresh brings it into fleet.status, with nothing else triggering a refresh.
// 2. The pool is then truncated in place, as a non-atomic write leaves it. fleet.status names the
//    pool in `poolErrors` and the slot keeps its resources; restoring the file clears the error.
//
// Run: yarn tsx scripts/runner-validation/gateway/fleet-refresh-pool-edit.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  poll,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import type { FleetStatusResult } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/fleet-refresh-pool-edit/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-refresh-pool-edit-')));
const slotId = 'pool-edit-slot';
const repo = path.join(fixture, 'repo');
const poolFile = path.join(fixture, 'pool/pool-edit.json');
const hold = path.join(fixture, 'git-hold');
const held = path.join(fixture, 'git-held');
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
const reaper = startReaper();
reaper.path(fixture);
const parts: IsolatedStackParts = {};
const cleanupErrors: unknown[] = [];
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  parts.connection?.close();
  await attempt(() => stopProcess(parts.gateway));
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  reaper.done();
});

const pool = (resources: Record<string, Record<string, string | number>>) => ({
  machine: 'pool-edit-host',
  host: 'localhost',
  ssh_user: process.env.USER ?? 'operator',
  project: 'pool-edit',
  platform: 'cli',
  os: process.platform,
  slots: [{ id: slotId, enabled: true, repo, session: slotId, resources }],
});
/** As an editor or a careful script does it: a temp file renamed over the pool. */
async function writePoolAtomically(value: unknown) {
  const temp = `${poolFile}.tmp-edit`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, poolFile);
}

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated fleet refresh fixture');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', '--initial-branch=main', repo]);
  await json(path.join(fixture, 'projects/pool-edit/project.json'), {
    name: 'pool-edit',
    repo_url: repo,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  });
  const before = { 'dev-server': { port: 7391 } };
  await json(poolFile, pool(before));
  // While the marker exists, every git call waits (bounded), holding the refresh's slot probe.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  await writeFile(
    path.join(shimDir, 'git'),
    [
      '#!/bin/sh',
      `if [ -e ${JSON.stringify(hold)} ]; then`,
      `  : > ${JSON.stringify(held)}`,
      '  i=0',
      `  while [ -e ${JSON.stringify(hold)} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`,
      'fi',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path.join(shimDir, 'git'), 0o755);
  const { connection: gw } = await startIsolatedStack(
    {
      root,
      evidence,
      env,
      fixture,
      reaper,
      gatewayEnv: { PATH: `${shimDir}:${process.env.PATH}` },
    },
    parts,
  );
  const slot = async () => {
    const { fleet } = await gw.call<FleetStatusResult>('fleet.status');
    return { fleet, row: fleet.slots.find((s) => s.slot === slotId) };
  };
  await poll(
    'the slot to be listed with its resources',
    async () => ((await slot()).row?.resources?.['dev-server'] ? true : undefined),
    60_000,
  );

  // 1. An edit made while a refresh is running reaches fleet.status by itself.
  await writeFile(hold, 'hold\n');
  const running = gw.call<FleetStatusResult>('fleet.status', { forceRefresh: true });
  // Awaited below; a failure before then must still fail the proof, not go unhandled.
  running.catch(() => undefined);
  await poll(
    'a refresh to be held in its slot probe',
    async () => existsSync(held) || undefined,
    30_000,
  );
  const watcherRefreshes = async () =>
    (await readFile(path.join(evidence, 'gateway.log'), 'utf8')).split(
      'pool config changed — triggering fleet refresh',
    ).length;
  const before_edit = await watcherRefreshes();
  const after = { ...before, browser: { cdp_port: 7691 } };
  await writePoolAtomically(pool(after));
  // The watcher's debounced refresh must ask while the held one still runs.
  await poll(
    'the pool watcher to ask for a refresh',
    async () => ((await watcherRefreshes()) > before_edit ? true : undefined),
    30_000,
  );
  await rm(hold, { force: true });
  await running;
  const seen = await poll(
    'the edit to reach fleet.status without another trigger',
    async () => ((await slot()).row?.resources?.browser ? (await slot()).row : undefined),
    30_000,
  );
  assert.deepEqual(seen?.resources?.browser, { cdp_port: 7691 });

  // 2. A pool left truncated by a non-atomic write is reported, and the slot keeps its rows.
  const full = JSON.stringify(pool(after), null, 2);
  await writeFile(poolFile, full.slice(0, Math.floor(full.length * 0.8)));
  const reported = await poll(
    'fleet.status to name the unreadable pool',
    async () => {
      const { fleet, row } = await slot();
      return fleet.poolErrors?.length ? { fleet, row } : undefined;
    },
    30_000,
  );
  assert.equal(reported.fleet.poolErrors?.[0]?.file, 'pool-edit.json');
  assert.match(reported.fleet.poolErrors?.[0]?.error ?? '', /JSON/);
  assert.deepEqual(
    reported.row?.resources,
    after,
    'the slot keeps the resources of the last good read',
  );
  await writeFile(poolFile, full);
  await poll(
    'the pool error to clear once the file parses',
    async () => ((await slot()).fleet.poolErrors === undefined ? true : undefined),
    30_000,
  );
  result = {
    pass: true,
    evidence,
    editDuringRefresh: seen?.resources,
    poolError: reported.fleet.poolErrors?.[0],
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  await rm(hold, { force: true });
  await cleanup();
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
