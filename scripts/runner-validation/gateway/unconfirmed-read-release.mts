#!/usr/bin/env tsx
// Live proof (F298) that one slow workspace read no longer hides a slot's workspace until its node
// reconnects. An isolated gateway and node (own pool, projects, runs and home) observe a slot
// whose node-side `python3` is a fixture: the first workspace probe leaves a process in its own
// session (out of reach of the node's process-group kill) holding the probe's output open for
// 25 s, longer than the read's budget, cancel closeout and transport grace. The read fails as an
// unconfirmed closeout; when the node finally delivers that result on the same connection, the
// next fleet read must show the workspace, with the node never reconnecting. macpro-audiolab-1
// stayed at "Execution … has unconfirmed closeout (timeout)" instead. macOS only: the node's zsh
// login supplies the fixture's PATH.
//
// Run: yarn tsx scripts/runner-validation/gateway/unconfirmed-read-release.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  poll,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson,
} from '../lib/isolated-stack.mjs';
import type { FleetStatusResult } from '../../../packages/protocol/src/index.js';

if (process.platform !== 'darwin' || spawnSync('perl', ['-v'], { stdio: 'ignore' }).status !== 0)
  throw new Error('This proof needs macOS (a zsh login for the node) and perl');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/unconfirmed-read-release/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'unconfirmed-read-release-')));
// Not a local host name, so the gateway reaches the slot through the registered node.
const machine = 'unconfirmed-read-node';
const slotId = 'unconfirmed-read-slot';
const repo = path.join(fixture, 'slot');
const origin = path.join(fixture, 'origin.git');
// Marks the first probe as slowed, and names the holder in its argv so cleanup can find it.
const slowed = path.join(fixture, 'slow-read-started');
const realPython = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
const parts: IsolatedStackParts = {};
const cleanupErrors: unknown[] = [];
const reaper = startReaper();
// The holder runs in its own session, outside every process group stopped here.
const stopHolder = ['pkill', '-f', slowed];
reaper.command(stopHolder, env);
reaper.path(fixture);
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  parts.connection?.close();
  await attempt(() => stopProcess(parts.node));
  await attempt(() => stopProcess(parts.gateway));
  spawnSync(stopHolder[0], stopHolder.slice(1), { stdio: 'ignore' });
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  reaper.done();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();

// What an operator reading the slot sees, once a second.
const timeline: Array<{ at: number; workspace: string | null; error: string | null }> = [];
let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated unconfirmed-read fixture');
  // The slot: a clean checkout of a real origin, so the workspace probe has a full answer.
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'Fixture slot\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // The node's `python3`: the first workspace probe leaves a holder of its output in its own
  // session, as a stuck read on a loaded machine does. The node's commands take their PATH from
  // its zsh login, so a login profile puts the fixture first.
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  await writeFile(
    path.join(shimDir, 'python3'),
    [
      '#!/bin/sh',
      `if [ "$1" = - ] && [ "$2" = ${JSON.stringify(repo)} ] && mkdir ${JSON.stringify(slowed)} 2>/dev/null; then`,
      `  perl -MPOSIX -e 'POSIX::setsid(); sleep 25' ${JSON.stringify(slowed)} </dev/null &`,
      'fi',
      `exec ${JSON.stringify(realPython)} "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path.join(shimDir, 'python3'), 0o755);
  const zdotdir = path.join(fixture, 'zdotdir');
  await mkdir(zdotdir);
  await writeFile(
    path.join(zdotdir, '.zprofile'),
    `export PATH=${JSON.stringify(shimDir)}:"$PATH"\n`,
  );
  await writeJson(path.join(fixture, 'projects/unconfirmed-read/project.json'), {
    name: 'unconfirmed-read',
    repo_url: origin,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
  });
  await writeJson(path.join(fixture, 'pool/unconfirmed-read.json'), {
    machine,
    host: `${machine}.invalid`,
    ssh_user: process.env.USER ?? 'operator',
    project: 'unconfirmed-read',
    platform: 'cli',
    os: process.platform,
    slots: [{ id: slotId, enabled: true, repo, session: slotId, resources: {} }],
  });
  await writeJson(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine,
        project: 'unconfirmed-read',
        platform: 'cli',
        repo,
        session: slotId,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        enabled: true,
        health: { ssh: 'OK', device: '-', devserver: '-', fixtures: '-' },
      },
    ],
  });
  const { connection: gw } = await startIsolatedStack(
    { root, evidence, env, fixture, reaper, node: { machine, env: { ZDOTDIR: zdotdir } } },
    parts,
  );

  const started = Date.now();
  let sawUnconfirmed = false;
  const recovered = await poll(
    'the workspace to be observed again after the late closeout',
    async () => {
      const { fleet } = await gw.call<FleetStatusResult>('fleet.status');
      const row = fleet.slots.find((slot) => slot.slot === slotId);
      const entry = {
        at: Math.round((Date.now() - started) / 1000),
        workspace: row?.workspace?.branch ?? null,
        error: row?.workspaceError ?? null,
      };
      const last = timeline.at(-1);
      if (!last || last.workspace !== entry.workspace || last.error !== entry.error)
        timeline.push(entry);
      if (/unconfirmed closeout/.test(entry.error ?? '')) sawUnconfirmed = true;
      await delay(1000);
      return sawUnconfirmed && entry.workspace && !entry.error ? entry : undefined;
    },
    120_000,
  );
  assert.equal(recovered.workspace, 'main');
  // A reconnect would clear the pin without the fix; the node kept its one connection.
  const opened = (await readFile(path.join(evidence, 'node.log'), 'utf8')).match(/Transport open/g);
  assert.equal(opened?.length, 1, 'the node connected once');
  assert.notEqual(
    spawnSync('pgrep', ['-f', slowed], { stdio: 'ignore' }).status,
    0,
    'the holder exited before the workspace came back',
  );
  result = { pass: true, evidence, recoveredAfterSeconds: recovered.at, timeline };
  await writeJson(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await writeJson(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  await writeJson(path.join(evidence, 'timeline.json'), timeline);
  await cleanup();
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
