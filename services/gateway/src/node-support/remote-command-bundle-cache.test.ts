// The node-support bundle is collected once per change of what it is built from, not on a timer.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { SlotVars } from '../core/index.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';

import type { NodeSupportIo } from './ensure.js';
import { resetRemoteFarmCommandCache, resolveRemoteFarmCommand } from './remote-command.js';
import { fakeSupportHomeResult } from './support-test-fixtures.js';

const { farmslotRoot } = await import('../core/config.js');

const PROJECT = `bundle-cache-${process.pid}-farm`;
const packRoot = path.join(farmslotRoot(), 'projects', PROJECT);
const script = path.join(packRoot, 'scripts', 'x.sh');
mkdirSync(path.dirname(script), { recursive: true });
writeFileSync(
  path.join(packRoot, 'project.json'),
  JSON.stringify({
    node_support: { paths: [`projects/${PROJECT}/scripts`, `projects/${PROJECT}/project.json`] },
    qa: {
      default_profile: 'smoke',
      profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
    },
  }),
);
writeFileSync(script, 'echo one\n');
// A pack may hold a dangling link outside its support paths (the pack check reads its target
// text); it must not look like a change on every check.
symlinkSync('not-there.md', path.join(packRoot, 'dangling.md'));
test.after(() => rmSync(packRoot, { recursive: true, force: true }));

// Each collection checks the pack once, starting with one `git -C <pack> ls-files`.
let collections = 0;
/** Runs when a collection starts checking the pack: lets a test change an input meanwhile. */
let duringCollection: (() => void) | undefined;
const execFile = childProcess.execFile;
mock.method(childProcess, 'execFile', (...args: Parameters<typeof execFile>) => {
  const argv = args[1];
  if (Array.isArray(argv) && argv[0] === '-C' && argv[1] === packRoot && argv[2] === 'ls-files') {
    collections++;
    duringCollection?.();
  }
  return execFile(...args);
});
syncBuiltinESMExports();
test.after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

const HOOK = `bash ~/farmslot-node/projects/${PROJECT}/scripts/x.sh`;

function remoteVars(slotId = 'mini-cache-1'): SlotVars {
  return {
    slotId,
    machine: 'mini',
    platform: 'ios',
    host: 'mini.local',
    sshUser: 'deeeed',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/Users/deeeed/dev/x',
    session: slotId,
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'deeeed@mini.local',
    remoteRepo: '/Users/deeeed/dev/x',
    projectName: PROJECT,
    resourceVars: {},
  };
}

/**
 * A node that holds whatever bundle this fake last received. With `upload`, each upload reports
 * that it started and finishes when that promise does.
 */
function fakeNode(upload?: { started: () => void; done: Promise<void> }) {
  let uploads = 0;
  let manifest: string | null = null;
  const staged = new Map<string, string>();
  const io: NodeSupportIo = {
    retentionReferences: async () => ({ selectionPaths: [], runHashes: [] }),
    exec: async (_vars, command) => {
      const cmd = staged.get(command) ?? command;
      const home = fakeSupportHomeResult(cmd);
      if (home) return home;
      const stage = /^mktemp '([^']+\/\.command\.)XXXXXX'$/.exec(cmd);
      if (stage) return { exitCode: 0, stdout: `${stage[1]}fixture\n`, stderr: '' };
      if (cmd.includes('mktemp -d'))
        return { exitCode: 0, stdout: '/home/u/farmslot-node/support/.incoming/x\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    fileExists: async () => manifest !== null,
    readFile: async (_vars, file) => {
      if (file.endsWith('manifest.json') && manifest) return manifest;
      throw new Error(`unexpected read ${file}`);
    },
    writeFile: async (_vars, file, data) => {
      staged.set(`/bin/sh ${shellExpressionForRemotePath(file)}`, data);
      if (file.endsWith('manifest.json')) manifest = data;
    },
    writeFiles: async () => {
      uploads++;
      upload?.started();
      await upload?.done;
    },
  };
  return { io, uploads: () => uploads };
}

/**
 * The test clock runs a minute ahead of the files' real modification times, so no input looks
 * written during a collection unless a test stamps it so.
 */
function aheadClock(t: test.TestContext, apis: ('Date' | 'setTimeout')[] = ['Date']) {
  t.mock.timers.enable({ apis, now: Date.now() + 60_000 });
  resetRemoteFarmCommandCache();
  collections = 0;
  duringCollection = undefined;
  t.after(() => {
    duringCollection = undefined;
    resetRemoteFarmCommandCache();
  });
}

test('commands in an unchanged tree collect the bundle once and deliver it once', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const first = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  // A prepare's worth of commands over several minutes, each past the check interval.
  for (let command = 0; command < 30; command++) {
    t.mock.timers.tick(3_000);
    assert.equal(await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io }), first);
  }
  assert.equal(collections, 1);
  assert.equal(node.uploads(), 1);
});

test('a support file edit and a file added to the pack each collect once more', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const before = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  writeFileSync(script, 'echo two\n');
  t.mock.timers.tick(3_000);
  const edited = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  t.mock.timers.tick(3_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 2, 'the edit');
  assert.notEqual(edited, before, 'the edit changes the bundle the command runs from');

  const added = path.join(packRoot, 'recipes', 'smoke.json');
  mkdirSync(path.dirname(added), { recursive: true });
  t.after(() => rmSync(path.dirname(added), { recursive: true, force: true }));
  writeFileSync(added, '{}');
  t.mock.timers.tick(3_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  t.mock.timers.tick(3_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 3, 'the added pack file');
  writeFileSync(added, '{"edited":true}');
  t.mock.timers.tick(3_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  t.mock.timers.tick(3_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 4, 'the edited pack file');
  writeFileSync(script, 'echo one\n');
});

test('concurrent commands after a change share one collection', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  writeFileSync(script, 'echo three\n');
  t.after(() => writeFileSync(script, 'echo one\n'));
  t.mock.timers.tick(3_000);
  const commands = await Promise.all(
    ['mini-cache-1', 'mini-cache-2', 'mini-cache-3', 'mini-cache-1'].map((slot) =>
      resolveRemoteFarmCommand(remoteVars(slot), HOOK, { io: node.io }),
    ),
  );
  assert.equal(new Set(commands).size, 1);
  assert.equal(collections, 2);
});

test('an input written while the bundle was being collected is collected again', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  t.after(() => writeFileSync(script, 'echo one\n'));
  duringCollection = () => {
    duringCollection = undefined;
    writeFileSync(script, 'echo four\n');
    // Written now, by the test clock: after the collection started.
    utimesSync(script, Date.now() / 1000, Date.now() / 1000);
  };
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  // Within the check interval: the bundle cannot be trusted, so it is collected again at once.
  t.mock.timers.tick(1);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 2);
  t.mock.timers.tick(3_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 2, 'and then held');
});

test('a delivery in flight keeps its budget while more commands arrive', async (t) => {
  aheadClock(t, ['Date', 'setTimeout']);
  let started!: () => void;
  const uploading = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const node = fakeNode({ started, done });
  // On the test clock each collection takes 4 s, like one of metamask-mobile-farm (3.3-5.6 s).
  duringCollection = () => t.mock.timers.tick(4_000);
  const first = resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io, budgetMs: 5_000 });
  await uploading;
  // 3 s into a 5 s budget, the slot's next command: past the check interval, nothing changed.
  t.mock.timers.tick(3_000);
  const second = resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io, budgetMs: 5_000 });
  // Give it time to start a collection (the code before this change did, at once), then deliver.
  const since = performance.now();
  while (collections < 2 && performance.now() - since < 300)
    await new Promise<void>((resolve) => setImmediate(resolve));
  finish();
  assert.equal(await first, await second);
  assert.equal(collections, 1);
  assert.equal(node.uploads(), 1);
});
