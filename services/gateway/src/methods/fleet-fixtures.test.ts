import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';

import type { ProjectVars, RawProjectJson, SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');
let disconnectedRepo: string | undefined;
const execution = await import('../core/exec.js');
const executeOnSlot: typeof execution.execOnSlot = async (...args) => {
  if (args[0].remoteRepo === disconnectedRepo && args[1].startsWith('cat '))
    throw new Error('Node disconnected during fixture content read');
  return execution.execOnSlot(...args);
};
mock.module('../core/exec.js', {
  namedExports: { ...execution, execOnSlot: executeOnSlot },
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
