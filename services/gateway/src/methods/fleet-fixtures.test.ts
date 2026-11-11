import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';

import type { ProjectVars, RawProjectJson, SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');
let disconnectedRepo: string | undefined;
/** Remote fixture reads (hashes and directory tests), counted per test. */
const fixtureReads: string[] = [];
let failBatchedRead = false;
/** Shell-read tests route a local fixture slot through the remote command path. */
let forceShellFixtureReads = false;
const execution = await import('../core/exec.js');
const executeOnSlot: typeof execution.execOnSlot = async (...args) => {
  if (args[0].remoteRepo === disconnectedRepo && args[1].startsWith('cat '))
    throw new Error('Node disconnected during fixture content read');
  if (/md5|test -d/.test(args[1])) {
    fixtureReads.push(args[1]);
    if (failBatchedRead && args[1].includes('; '))
      throw new Error('Node disconnected during the batched fixture read');
  }
  return execution.execOnSlot(...args);
};
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: executeOnSlot,
    slotFilesReadInProcess: (vars: Parameters<typeof execution.slotFilesReadInProcess>[0]) =>
      !forceShellFixtureReads && execution.slotFilesReadInProcess(vars),
  },
});
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: { ...core, execOnSlot: executeOnSlot },
});
const { checkFixtures } = await import('./fleet.js');
const { checkFixtureSteps } = await import('./slot/check.js');

async function fixture(t: TestContext, projectJson: RawProjectJson) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-fixtures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout');
  const sources = path.join(root, 'fixtures');
  await mkdir(repo);
  await mkdir(sources);
  const vars: SlotVars = {
    slotId: 'fixture-slot',
    machine: os.hostname(),
    platform: 'web',
    host: 'localhost',
    sshUser: 'fixture',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo,
    remoteRepo: repo,
    session: 'fixture-slot',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    projectName: 'fixture',
    resourceVars: {},
  };
  const project: ProjectVars = {
    projectName: 'fixture',
    projectConfig: path.join(root, 'project.json'),
    projectFixturesDir: sources,
    projectTemplatesDir: path.join(root, 'templates'),
    runtimeDir: 'temp/runtime',
    artifactDir: 'temp/tasks',
    projectJson,
  };
  const file = async (base: string, name: string, content: string) => {
    const target = path.join(base, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  return {
    vars,
    project,
    repo,
    sources,
    file,
    check: () => checkFixtures(vars, project, projectJson),
  };
}

test('aggregate fixture verification expands runtime destinations', async (t) => {
  const f = await fixture(t, {
    fixtures: { templates: [{ src: 'seed', dst: '{{runtime_dir}}/seed' }] },
  });
  await f.file(f.sources, 'seed', 'required\n');
  await f.file(f.repo, 'temp/runtime/seed', 'required\n');
  assert.equal(await f.check(), 'OK');
});

test('aggregate directory verification expands runtime destinations', async (t) => {
  const f = await fixture(t, {
    fixtures: { directories: [{ src: 'tree', dst: '{{runtime_dir}}/tree', sentinel: 'stamp' }] },
  });
  await f.file(f.sources, 'tree/stamp', 'current\n');
  await f.file(f.repo, 'temp/runtime/tree/stamp', 'current\n');
  assert.equal(await f.check(), 'OK');
});

test('aggregate fixture verification preserves accepted installer exclusions', async (t) => {
  const f = await fixture(t, {
    fixtures: { templates: [{ src: 'exclude', dst: '.git/info/exclude' }] },
  });
  await f.file(f.sources, 'exclude', '.agent/\n');
  await f.file(f.repo, '.git/info/exclude', '.agent/\n.cache/\n');
  assert.equal(await f.check(), 'OK');
  await f.file(f.repo, '.git/info/exclude', '.cache/\n');
  assert.equal(await f.check(), '0/1');
});

test('aggregate fixture verification preserves accepted skills installer settings', async (t) => {
  const f = await fixture(t, {
    repo_url: 'git@example.invalid:org/proof.git',
    fixtures: { templates: [{ src: 'skills', dst: '.skills.local' }] },
  });
  await f.file(f.sources, 'skills', 'CONSENSYS_SKILLS_DIR=.skills-cache/consensys-skills\n');
  await f.file(
    f.repo,
    '.skills.local',
    'CONSENSYS_SKILLS_DIR=.skills-cache/consensys-skills\nMETAMASK_SKILLS_DIR=.skills-cache/metamask-skills\nMETAMASK_SKILLS_TARGET_REPO=proof\n',
  );
  assert.equal(await f.check(), 'OK');
});

test('optional missing fixtures stay outside the denominator', async (t) => {
  const f = await fixture(t, {
    fixtures: { templates: [{ src: 'missing', dst: 'optional', optional: true }] },
  });
  assert.equal(await f.check(), 'not-required');
});

test('installer read failure remains a fixture warning while sibling slots verify', async (t) => {
  const project: RawProjectJson = {
    fixtures: { templates: [{ src: 'exclude', dst: '.git/info/exclude' }] },
  };
  const failed = await fixture(t, project);
  const sibling = await fixture(t, project);
  for (const f of [failed, sibling]) {
    await f.file(f.sources, 'exclude', '.agent/\n');
    await f.file(f.repo, '.git/info/exclude', '.agent/\n.cache/\n');
  }
  disconnectedRepo = failed.repo;
  t.after(() => {
    disconnectedRepo = undefined;
  });
  assert.deepEqual(await Promise.all([failed.check(), sibling.check()]), ['0/1', 'OK']);
  const steps = await checkFixtureSteps(failed.vars, failed.project, project);
  assert.deepEqual(steps[0], {
    name: 'fixture:.git/info/exclude',
    status: 'warn',
    detail: '.git/info/exclude read failed: Node disconnected during fixture content read',
  });
});

function shellFixtureReads(t: TestContext): void {
  forceShellFixtureReads = true;
  t.after(() => {
    forceShellFixtureReads = false;
  });
}

test('one remote command reads every fixture hash and directory of a check', async (t) => {
  shellFixtureReads(t);
  const f = await fixture(t, {
    fixtures: {
      templates: [
        { src: 'a', dst: 'a.txt' },
        { src: 'b', dst: 'nested/b.txt' },
        { src: 'c', dst: "c with 'quote'.txt" },
      ],
      directories: [{ src: 'tree', dst: 'tree', sentinel: 'stamp' }],
    },
  });
  for (const [name, content] of [
    ['a', 'one\n'],
    ['b', 'two\n'],
    ['c', 'three\n'],
    ['tree/stamp', 'current\n'],
  ])
    await f.file(f.sources, name, content);
  for (const [name, content] of [
    ['a.txt', 'one\n'],
    ['nested/b.txt', 'two\n'],
    ["c with 'quote'.txt", 'three\n'],
    ['tree/stamp', 'current\n'],
  ])
    await f.file(f.repo, name, content);
  fixtureReads.length = 0;
  assert.equal(await f.check(), 'OK');
  assert.equal(fixtureReads.length, 1, 'every hash and directory test in one command');

  // A drifted file, a missing file and a missing directory are still each reported.
  await f.file(f.repo, 'a.txt', 'changed\n');
  await rm(path.join(f.repo, 'nested/b.txt'));
  await rm(path.join(f.repo, 'tree'), { recursive: true });
  const steps = await checkFixtureSteps(f.vars, f.project, f.project.projectJson);
  const status = Object.fromEntries(steps.map((step) => [step.name, step.status]));
  assert.equal(status['fixture:a.txt'], 'warn');
  assert.equal(status['fixture:nested/b.txt'], 'warn');
  assert.equal(status["fixture:c with 'quote'.txt"], 'pass');
  assert.equal(status['fixture:tree/'], 'warn');
});

test('a failed batched fixture read falls back to per-fixture reads', async (t) => {
  const f = await fixture(t, {
    fixtures: {
      templates: [
        { src: 'a', dst: 'a.txt' },
        { src: 'b', dst: 'b.txt' },
      ],
    },
  });
  await f.file(f.sources, 'a', 'one\n');
  await f.file(f.sources, 'b', 'two\n');
  await f.file(f.repo, 'a.txt', 'one\n');
  await f.file(f.repo, 'b.txt', 'two\n');
  shellFixtureReads(t);
  failBatchedRead = true;
  t.after(() => {
    failBatchedRead = false;
  });
  fixtureReads.length = 0;
  assert.equal(await f.check(), 'OK');
  assert.ok(fixtureReads.length > 1, 'the per-fixture reads ran after the batch failed');
});

test('a local slot reads fixture hashes and directories without a command', async (t) => {
  const f = await fixture(t, {
    fixtures: {
      templates: [
        { src: 'a', dst: 'a.txt' },
        { src: 'b', dst: 'nested/b.txt' },
      ],
      directories: [{ src: 'tree', dst: 'tree', sentinel: 'stamp' }],
    },
  });
  for (const [name, content] of [
    ['a', 'one\n'],
    ['b', 'two\n'],
    ['tree/stamp', 'current\n'],
  ]) {
    await f.file(f.sources, name, content);
    await f.file(f.repo, name === 'b' ? 'nested/b.txt' : name === 'a' ? 'a.txt' : name, content);
  }
  fixtureReads.length = 0;
  assert.equal(await f.check(), 'OK');
  assert.deepEqual(fixtureReads, [], 'no hash or directory command for a local slot');

  await f.file(f.repo, 'a.txt', 'changed\n');
  await rm(path.join(f.repo, 'nested/b.txt'));
  await rm(path.join(f.repo, 'tree'), { recursive: true });
  const steps = await checkFixtureSteps(f.vars, f.project, f.project.projectJson);
  const status = Object.fromEntries(steps.map((step) => [step.name, step.status]));
  assert.equal(status['fixture:a.txt'], 'warn');
  assert.equal(status['fixture:nested/b.txt'], 'warn');
  assert.equal(status['fixture:tree/'], 'warn');
  assert.deepEqual(fixtureReads, []);
});

test('a local fixture keeps its hash until its size, mtime or inode changes', async (t) => {
  const f = await fixture(t, { fixtures: { templates: [{ src: 'seed', dst: 'seed.txt' }] } });
  const target = path.join(f.repo, 'seed.txt');
  const stamp = 1_700_000_000;
  await f.file(f.sources, 'seed', 'aaaa\n');
  await f.file(f.repo, 'seed.txt', 'aaaa\n');
  await utimes(target, stamp, stamp);
  assert.equal(await f.check(), 'OK');

  // Same size, same inode, same mtime: the stamp is unchanged, so the cached hash is served.
  const inode = (await stat(target)).ino;
  await writeFile(target, 'bbbb\n');
  await utimes(target, stamp, stamp);
  assert.equal((await stat(target)).ino, inode);
  assert.equal(await f.check(), 'OK', 'an unchanged stamp is not hashed again');

  // A new mtime hashes again and reports the drift.
  await utimes(target, stamp + 1, stamp + 1);
  assert.equal(await f.check(), '0/1');

  // Restored content with the original mtime but a new inode (atomic replace) hashes again.
  await writeFile(`${target}.tmp`, 'aaaa\n');
  await rename(`${target}.tmp`, target);
  await utimes(target, stamp + 1, stamp + 1);
  assert.notEqual((await stat(target)).ino, inode);
  assert.equal(await f.check(), 'OK');
});
