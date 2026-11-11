import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { farmslotRoot, invalidateProjectVarsCache, loadProjectVars } from './config.js';
import {
  isPackCopiedProject,
  readSourceRuntimeSettings,
  writeSourceRuntimeSettings,
} from './source-runtime-settings.js';

test('mutable project policy retains backups in a farm root without writing source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-policy-test-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  try {
    const source = path.join(root, 'sealed-source');
    await mkdir(source);
    const bytes = '{"name":"demo","backlog":{"auto_dispatch":{"enabled":false}}}';
    await writeFile(path.join(source, 'project.json'), bytes);
    const firstBackup = await writeSourceRuntimeSettings('demo', {
      backlog: { auto_dispatch: { enabled: true } },
    });
    assert.deepEqual(JSON.parse(await readFile(firstBackup, 'utf8')).values, {});
    const secondBackup = await writeSourceRuntimeSettings('demo', {
      auto_recovery: { enabled: false },
    });
    assert.equal(
      JSON.parse(await readFile(secondBackup, 'utf8')).values.backlog.auto_dispatch.enabled,
      true,
    );
    assert.deepEqual(await readSourceRuntimeSettings('demo'), {
      backlog: { auto_dispatch: { enabled: true } },
      auto_recovery: { enabled: false },
    });
    assert.equal(await readFile(path.join(source, 'project.json'), 'utf8'), bytes);
    const delegation = {
      delegatedReviewerPrincipalIds: ['lead'],
      delegatorPrincipalId: 'person',
    };
    await writeSourceRuntimeSettings('demo', { visual_claim_review: delegation });
    assert.deepEqual((await readSourceRuntimeSettings('demo')).visual_claim_review, {
      ...delegation,
    });
    assert.equal(await readFile(path.join(source, 'project.json'), 'utf8'), bytes);
    await assert.rejects(
      writeSourceRuntimeSettings('demo', { visual_claim_review: { delegatorPrincipalId: '' } }),
      /Invalid project visualClaimReview/,
    );
    await assert.rejects(writeSourceRuntimeSettings('../escape', {}), /Invalid/);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a pack-copied project reads its policy from runtime settings, a hand-managed one does not', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pack-policy-test-'));
  const previous = {
    FARMSLOT_HOME: process.env.FARMSLOT_HOME,
    FARMSLOT_WORKSPACE: process.env.FARMSLOT_WORKSPACE,
  };
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_WORKSPACE = home;
  const project = `pack-policy-${process.pid}`;
  const directory = path.join(farmslotRoot(), 'projects', project);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(directory, { recursive: true });
  const shipped = { auto_dispatch: { enabled: false } };
  await writeFile(
    path.join(directory, 'project.json'),
    JSON.stringify({ name: project, backlog: shipped }),
  );
  await writeSourceRuntimeSettings(project, { backlog: { auto_dispatch: { enabled: true } } });

  // A workspace without state.json records no packs: project.json stands.
  assert.equal(isPackCopiedProject(project), false);
  assert.deepEqual((await loadProjectVars(project)).projectJson.backlog, shipped);
  // `farmslot add` recorded it as copied from a pack: the farm's runtime settings win.
  await writeFile(
    path.join(home, 'state.json'),
    JSON.stringify({ schema_version: 1, packs: { pack: { projects: [project] } } }),
  );
  invalidateProjectVarsCache(project);
  assert.equal(isPackCopiedProject(project), true);
  assert.deepEqual((await loadProjectVars(project)).projectJson.backlog, {
    auto_dispatch: { enabled: true },
  });
});

test('pack-copied projects read state.json again only when it changes', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pack-state-stamp-test-'));
  const previous = process.env.FARMSLOT_WORKSPACE;
  process.env.FARMSLOT_WORKSPACE = home;
  const state = path.join(home, 'state.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_WORKSPACE;
    else process.env.FARMSLOT_WORKSPACE = previous;
    // The test may stop while the file is unreadable; give it back its mode before removing it.
    if (existsSync(state)) await chmod(state, 0o644);
    await rm(home, { recursive: true, force: true });
  });
  const packs = (projects: string[]) =>
    JSON.stringify({ schema_version: 1, packs: { pack: { projects } } });
  await writeFile(state, packs(['copied']));
  assert.equal(isPackCopiedProject('copied'), true);
  assert.equal(isPackCopiedProject('hand-managed'), false);
  // chmod changes neither inode, size nor mtime: a lookup that read the file again would fail.
  await chmod(state, 0o000);
  assert.equal(isPackCopiedProject('copied'), true);
  await chmod(state, 0o644);
  await writeFile(state, packs(['hand-managed']));
  assert.equal(isPackCopiedProject('copied'), false);
  assert.equal(isPackCopiedProject('hand-managed'), true);
});

test('source runtime settings retain and validate approval policy overrides', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'approval-policy-settings-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeSourceRuntimeSettings('policy-test', { approvalPolicy: { maxNits: 0 } });
  const expected = { maxNits: 0, minorVerdict: 'COMMENT', majorVerdict: 'REQUEST_CHANGES' };
  assert.deepEqual((await readSourceRuntimeSettings('policy-test')).approvalPolicy, expected);
  await assert.rejects(
    writeSourceRuntimeSettings('policy-test', { approvalPolicy: { maxNits: -1 } }),
    /Invalid approvalPolicy/,
  );
  assert.deepEqual((await readSourceRuntimeSettings('policy-test')).approvalPolicy, expected);
});
