// The node-support bundle is collected once per change of what it is built from, not on a timer.
// A miniature farm root (the runner files, one small pack, one pool file) keeps each collection to
// a few files and three `git` calls.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { SlotVars } from '../core/index.js';

import type { NodeSupportIo } from './ensure.js';
import { fakeSupportHomeResult, seedRunnerObservabilityFixture } from './support-test-fixtures.js';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundle-cache-')));
const PROJECT = 'cache-farm';
const packRoot = path.join(root, 'projects', PROJECT);
const poolDir = path.join(root, 'pool');
const environment = {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: poolDir,
  FARMSLOT_HOME: path.join(root, 'home'),
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
for (const dir of ['scripts', 'services/gateway', 'pool', 'home'])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable bundle cache fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'scripts/write-runtime-context.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(path.join(poolDir, 'testbox.json'), JSON.stringify({ machine: 'testbox' }));
await seedRunnerObservabilityFixture(root);
writeFileSync(path.join(root, 'scripts/lib/resolve-farmslot-cli.sh'), '#!/bin/sh\n');

const script = path.join(packRoot, 'scripts', 'x.sh');
const nested = path.join(packRoot, 'scripts', 'sub', 'y.sh');
mkdirSync(path.dirname(nested), { recursive: true });
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
writeFileSync(nested, 'echo nested\n');
// Ignored: `notes/` holds no owned file, `runs/` is runtime state.
writeFileSync(path.join(packRoot, '.gitignore'), '*.log\nruns/\n');
mkdirSync(path.join(packRoot, 'notes'));
writeFileSync(path.join(packRoot, 'notes', 'a.log'), 'log\n');
mkdirSync(path.join(packRoot, 'runs'));
// Links outside the support paths, which the pack check reads as their target text.
mkdirSync(path.join(packRoot, 'docs'));
symlinkSync('not-there.md', path.join(packRoot, 'docs', 'dangling.md'));
symlinkSync('self', path.join(packRoot, 'docs', 'self'));
execFileSync('git', ['init', '-q', packRoot]);

// A second pack whose project directory is a link to it, elsewhere in the root.
const LINKED = 'linked-farm';
const linkedTarget = path.join(root, 'packs', LINKED);
mkdirSync(path.join(linkedTarget, 'scripts'), { recursive: true });
writeFileSync(
  path.join(linkedTarget, 'project.json'),
  JSON.stringify({
    node_support: { paths: [`projects/${LINKED}/scripts`, `projects/${LINKED}/project.json`] },
    qa: {
      default_profile: 'smoke',
      profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
    },
  }),
);
writeFileSync(path.join(linkedTarget, 'scripts', 'z.sh'), 'echo linked\n');
execFileSync('git', ['init', '-q', linkedTarget]);
symlinkSync(linkedTarget, path.join(root, 'projects', LINKED));

// Each collection checks its pack once, starting with one `git -C <pack> ls-files -c`.
let collections = 0;
/** Runs when a collection starts checking the pack: lets a test change an input meanwhile. */
let duringCollection: (() => void) | undefined;
/** Runs when a collection, its pack listed, locates the pack's ownership rules. */
let duringRules: (() => void) | undefined;
const execFile = childProcess.execFile;
mock.method(childProcess, 'execFile', (...args: Parameters<typeof execFile>) => {
  const argv = args[1];
  if (Array.isArray(argv) && argv[0] === '-C' && argv[1].startsWith(`${root}/projects/`)) {
    if (argv[2] === 'ls-files' && argv[3] === '-c') {
      collections++;
      duringCollection?.();
    }
    if (argv[2] === 'rev-parse') duringRules?.();
  }
  return execFile(...args);
});
/** While set, reading the pool directory fails the way a file-descriptor shortage does. */
let poolUnreadable = false;
const statSync = fs.statSync;
mock.method(fs, 'statSync', (...args: Parameters<typeof statSync>) => {
  if (poolUnreadable && args[0] === poolDir)
    throw Object.assign(new Error(`EMFILE: too many open files, stat '${poolDir}'`), {
      code: 'EMFILE',
    });
  return statSync(...args);
});
syncBuiltinESMExports();
test.after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(previous))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

const { shellExpressionForRemotePath } = await import('../core/remote-paths.js');
const { resetRemoteFarmCommandCache, resolveRemoteFarmCommand } =
  await import('./remote-command.js');

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
 * recently changed unless a test stamps it so, and sits half a second into a whole second.
 */
function aheadClock(t: test.TestContext, apis: ('Date' | 'setTimeout')[] = ['Date']) {
  t.mock.timers.enable({ apis, now: Math.floor(Date.now() / 1000) * 1000 + 60_500 });
  resetRemoteFarmCommandCache();
  collections = 0;
  duringCollection = undefined;
  duringRules = undefined;
  t.after(() => {
    duringCollection = undefined;
    duringRules = undefined;
    poolUnreadable = false;
    resetRemoteFarmCommandCache();
  });
}

/** One command after the check interval. */
async function later(t: test.TestContext, io: NodeSupportIo): Promise<string> {
  t.mock.timers.tick(3_000);
  return resolveRemoteFarmCommand(remoteVars(), HOOK, { io });
}

test('commands in an unchanged tree collect the bundle once and deliver it once', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const first = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  // A prepare's worth of commands over a minute, each past the check interval.
  for (let command = 0; command < 10; command++) assert.equal(await later(t, node.io), first);
  // Runtime state in an ignored directory is not an input.
  writeFileSync(path.join(packRoot, 'runs', 'r1.json'), '{}');
  t.after(() => rmSync(path.join(packRoot, 'runs', 'r1.json'), { force: true }));
  assert.equal(await later(t, node.io), first);
  assert.equal(collections, 1);
  assert.equal(node.uploads(), 1);
});

test('external catalogs select a bundle without script hooks and invalidate it only when inputs change', async (t) => {
  aheadClock(t);
  const name = 'external-cache-farm';
  const pack = path.join(root, 'projects', name);
  const firstRoot = path.join(root, 'external-one');
  const secondRoot = path.join(root, 'external-two');
  for (const dir of [pack, path.join(firstRoot, 'dev'), path.join(secondRoot, 'dev')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(pack, 'project.json'),
    JSON.stringify({
      qa: {
        default_profile: 'smoke',
        profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
      },
      execution_templates: {
        sources: [{ id: 'package:cook', kind: 'package', root: { env: 'CACHE_COOK_ROOT' } }],
      },
    }),
  );
  writeFileSync(path.join(firstRoot, 'dev/core.md'), '# First\n- [ ] One\n');
  writeFileSync(path.join(secondRoot, 'dev/core.md'), '# Second\n- [ ] Two\n');
  const previousRoot = process.env.CACHE_COOK_ROOT;
  process.env.CACHE_COOK_ROOT = firstRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CACHE_COOK_ROOT;
    else process.env.CACHE_COOK_ROOT = previousRoot;
    for (const dir of [pack, firstRoot, secondRoot]) rmSync(dir, { recursive: true, force: true });
  });
  const node = fakeNode();
  const vars = { ...remoteVars('external-cache-1'), projectName: name };
  const command = () =>
    resolveRemoteFarmCommand(vars, '~/farmslot-node', { io: node.io, supportRoot: true });
  const first = await command();
  assert.match(first, /\/support\/[a-f0-9]{64}$/);
  assert.equal(await command(), first);
  assert.equal(collections, 1);
  process.env.CACHE_COOK_ROOT = secondRoot;
  const second = await command();
  assert.notEqual(
    second,
    first,
    'binding changes cannot wait behind the filesystem check interval',
  );
  assert.equal(collections, 2);
  appendFileSync(path.join(secondRoot, 'dev/core.md'), '\n- [ ] New instruction\n');
  t.mock.timers.tick(3_000);
  const edited = await command();
  assert.notEqual(edited, second);
  assert.equal(collections, 3);
  assert.equal(await command(), edited);
  assert.equal(collections, 3);
});

test('a support file edit and a file added to or edited in the pack each collect once more', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  t.after(() => writeFileSync(script, 'echo one\n'));
  const added = path.join(packRoot, 'recipes', 'smoke.json');
  t.after(() => rmSync(path.dirname(added), { recursive: true, force: true }));
  const before = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  writeFileSync(script, 'echo two\n');
  const edited = await later(t, node.io);
  await later(t, node.io);
  assert.equal(collections, 2, 'the edit');
  assert.notEqual(edited, before, 'the edit changes the bundle the command runs from');

  mkdirSync(path.dirname(added), { recursive: true });
  writeFileSync(added, '{}');
  await later(t, node.io);
  await later(t, node.io);
  assert.equal(collections, 3, 'the added pack file');
  writeFileSync(added, '{"edited":true}');
  await later(t, node.io);
  await later(t, node.io);
  assert.equal(collections, 4, 'the edited pack file');
});

test('pack ownership changes made only in Git or in ignore rules each collect once more', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const exclude = path.join(packRoot, '.git', 'info', 'exclude');
  const fresh = path.join(packRoot, 'notes', 'b.md');
  t.after(() => {
    execFileSync('git', [
      '-C',
      packRoot,
      'rm',
      '-q',
      '--cached',
      '--ignore-unmatch',
      'notes/a.log',
    ]);
    writeFileSync(exclude, '');
    rmSync(fresh, { force: true });
  });
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  // An ignored file becomes owned through the index alone.
  execFileSync('git', ['-C', packRoot, 'add', '-f', 'notes/a.log']);
  await later(t, node.io);
  await later(t, node.io);
  assert.equal(collections, 2, 'the index');
  appendFileSync(exclude, 'docs/\n');
  await later(t, node.io);
  await later(t, node.io);
  assert.equal(collections, 3, 'info/exclude');
  // `notes/` holds no file the pack owned until now.
  writeFileSync(fresh, 'note\n');
  await later(t, node.io);
  await later(t, node.io);
  assert.equal(collections, 4, 'a new file in a directory without owned files');
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

test('an input written in the same coarse timestamp tick as a collection is collected again', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  t.after(() => writeFileSync(script, 'echo one\n'));
  duringCollection = () => {
    duringCollection = undefined;
    writeFileSync(script, 'echo four\n');
    // A whole-second timestamp, as some filesystems keep: half a second before the collection began.
    const second = Math.floor(Date.now() / 1000);
    utimesSync(script, second, second);
  };
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  // Within the check interval it is served, as any bundle is between checks.
  t.mock.timers.tick(1);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 1);
  // Past it, it cannot be trusted and is collected again; that write is settled by now.
  await later(t, node.io);
  assert.equal(collections, 2);
  await later(t, node.io);
  assert.equal(collections, 2, 'and then held');
});

test('an input that stays unsettled is collected again at most every 2 seconds', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  t.after(() => writeFileSync(script, 'echo one\n'));
  // Copied from a host whose clock runs an hour ahead.
  const ahead = Date.now() / 1000 + 3_600;
  utimesSync(script, ahead, ahead);
  for (let command = 0; command < 20; command++) {
    await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
    t.mock.timers.tick(500);
  }
  // Ten seconds of commands every 500 ms.
  assert.equal(collections, 5);
});

test('a held bundle is collected again after 10 minutes whatever its inputs show', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  t.mock.timers.tick(9 * 60_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 1);
  t.mock.timers.tick(60_000);
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(collections, 2);
});

test('an ignore rule deleted while the pack is checked is collected again', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const exclude = path.join(packRoot, '.git', 'info', 'exclude');
  const secret = path.join(packRoot, 'secret.md');
  writeFileSync(exclude, 'secret.md\n');
  writeFileSync(secret, 'cat /Users/someone/secret\n');
  t.after(() => {
    writeFileSync(exclude, '');
    rmSync(secret, { force: true });
  });
  // After the pack's files were listed with the rule, before the inputs are stamped.
  duringRules = () => {
    duringRules = undefined;
    rmSync(exclude);
    const now = Date.now() / 1000;
    utimesSync(path.dirname(exclude), now, now);
  };
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  await assert.rejects(later(t, node.io), /not portable/);
  assert.equal(collections, 2);
});

test('a pack whose .git is unusable is checked as a copied pack', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const gitDir = path.join(packRoot, '.git');
  renameSync(gitDir, `${gitDir}-aside`);
  // A worktree pointer to a pruned repository.
  writeFileSync(gitDir, 'gitdir: /nonexistent/worktree\n');
  t.after(() => {
    rmSync(gitDir, { force: true });
    renameSync(`${gitDir}-aside`, gitDir);
  });
  const first = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(await later(t, node.io), first);
  assert.equal(collections, 1);
});

test('a file added at a linked pack root collects once more', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const linkedVars = { ...remoteVars(), projectName: LINKED };
  const linkedHook = `bash ~/farmslot-node/projects/${LINKED}/scripts/z.sh`;
  const fresh = path.join(linkedTarget, 'fresh.md');
  t.after(() => rmSync(fresh, { force: true }));
  const command = () => resolveRemoteFarmCommand(linkedVars, linkedHook, { io: node.io });
  await command();
  t.mock.timers.tick(3_000);
  await command();
  writeFileSync(fresh, 'new\n');
  t.mock.timers.tick(3_000);
  await command();
  assert.equal(collections, 2);
});

test('a failed check does not fail the commands after it', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const first = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  poolUnreadable = true;
  await assert.rejects(later(t, node.io), /EMFILE/);
  poolUnreadable = false;
  assert.equal(await later(t, node.io), first);
  assert.equal(collections, 1);
});

test('a failed collection does not fail the commands after it', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const leak = path.join(packRoot, 'leak.md');
  t.after(() => rmSync(leak, { force: true }));
  await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  writeFileSync(leak, 'cat /Users/someone/secret\n');
  await assert.rejects(later(t, node.io), /not portable/);
  rmSync(leak);
  await later(t, node.io);
  assert.equal(collections, 3);
});

test('a support directory replaced by a file is collected again', async (t) => {
  aheadClock(t);
  const node = fakeNode();
  const sub = path.dirname(nested);
  t.after(() => {
    rmSync(sub, { recursive: true, force: true });
    mkdirSync(sub);
    writeFileSync(nested, 'echo nested\n');
  });
  const before = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  rmSync(sub, { recursive: true });
  writeFileSync(sub, 'echo now a file\n');
  assert.notEqual(await later(t, node.io), before);
  assert.equal(collections, 2);
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
