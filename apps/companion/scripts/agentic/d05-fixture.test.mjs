import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { register } from 'tsx/esm/api';

import {
  D05FixtureOwner,
  d05NativeControl,
  d05RecipeErrors,
  optionalStat,
  resolveD05Inputs,
} from './d05-fixture.mjs';

async function temporary(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'd05-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reuse retains existing files and directories; cleanup removes only new files', async (t) => {
  const root = await temporary(t);
  const project = path.join(root, 'project');
  await mkdir(project);
  const retained = path.join(project, 'retained');
  await writeFile(retained, 'same');
  const owner = new D05FixtureOwner([project]);
  await owner.directory(project);
  await owner.write(retained, 'same');
  await owner.write(path.join(project, 'new'), 'owned');
  await owner.cleanup();
  assert.equal(await readFile(retained, 'utf8'), 'same');
  assert.equal(await optionalStat(path.join(project, 'new')), undefined);
  assert((await optionalStat(project)).isDirectory());
});

test('new directories retain foreign sentinels and changed file contents', async (t) => {
  const root = await temporary(t);
  const project = path.join(root, 'project');
  const owner = new D05FixtureOwner([project]);
  const file = path.join(project, 'task', 'owned');
  await owner.write(file, 'ours');
  await writeFile(file, 'later writer');
  await writeFile(path.join(project, 'task', 'sentinel'), 'foreign');
  // Persisted receipts use this same journal in a subsequent helper process.
  await new D05FixtureOwner([project], JSON.parse(JSON.stringify(owner.journal))).cleanup();
  assert.equal(await readFile(file, 'utf8'), 'later writer');
  assert.equal(await readFile(path.join(project, 'task', 'sentinel'), 'utf8'), 'foreign');
});

test('different reserved file is rejected and is never adopted for cleanup', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'task');
  await writeFile(file, 'foreign');
  const owner = new D05FixtureOwner([root]);
  await assert.rejects(owner.write(file, 'ours'), /differs/);
  await owner.cleanup();
  assert.equal(await readFile(file, 'utf8'), 'foreign');
});

test('scratch ownership rejects lexical and symlink escapes', async (t) => {
  const root = await temporary(t);
  const project = path.join(root, 'project');
  await mkdir(project);
  await symlink(root, path.join(project, 'escape'));
  const owner = new D05FixtureOwner([project]);
  await assert.rejects(owner.write(path.join(root, 'outside'), 'no'), /escapes/);
  await assert.rejects(owner.write(path.join(project, 'escape', 'outside'), 'no'), /symlink/);
  assert.equal(await optionalStat(path.join(root, 'outside')), undefined);
});

test('dry resolver aggregates absent inputs without disclosing credential values', async (t) => {
  const root = await temporary(t);
  const secret = 'private-credential-never-render';
  await assert.rejects(resolveD05Inputs({ FARMSLOT_GATEWAY_TOKEN: secret }, root), (error) => {
    for (const name of [
      'FARMSLOT_HOME',
      'PLATFORM',
      'IOS_SIMULATOR',
      'METRO_PORT',
      'FARMSLOT_RUN_PROOF_FIXTURE',
      'baseline.runFile',
      'FARMSLOT_D05_WORKER_TASK',
      'FARMSLOT_NATIVE_VISUAL_IOS_PROFILE',
      'FARMSLOT_NATIVE_VISUAL_SOURCE',
      'FARMSLOT_PROJECTS_DIR',
      'FARMSLOT_D05_ARTIFACT_ROOT',
      'living recipe',
    ]) {
      assert(error.message.includes(name), `Missing aggregate diagnostic for ${name}`);
    }
    assert(!error.message.includes(secret));
    return true;
  });
  assert.equal(await optionalStat(path.join(root, 'projects')), undefined);
});

test('preflight validates the actual recipe and action manifest before a device is imported', async (t) => {
  // CI runs host tests without emitted workspace packages. Resolve the same public
  // validator against checkout source, as the repository TypeScript suites do.
  const imported = [];
  const unregister = register({
    tsconfig: fileURLToPath(new URL('../../../../services/gateway/tsconfig.json', import.meta.url)),
    onImport: (url) => imported.push(url),
  });
  t.after(unregister);
  const recipe = JSON.parse(
    await readFile(
      new URL('./recipe/recipes/recorded-visual-runs-live.recipe.json', import.meta.url),
      'utf8',
    ),
  );
  const manifest = JSON.parse(
    await readFile(new URL('./recipe/action-manifest.json', import.meta.url), 'utf8'),
  );
  const params = { detail_title: 'Owned offline closeout fixture' };
  assert.deepEqual(await d05RecipeErrors(recipe, manifest, params), []);
  assert(imported.some((url) => url.endsWith('/packages/protocol/src/index.ts')));
  recipe.paramsSchema.properties.detail_title.minLength = 1;
  assert(
    (await d05RecipeErrors(recipe, manifest, params)).some((finding) =>
      finding.path.includes('minLength'),
    ),
  );
  delete recipe.paramsSchema.properties.detail_title.minLength;
  recipe.workflow.nodes.before.action = 'not-a-runner-action';
  assert(
    (await d05RecipeErrors(recipe, manifest, params)).some(
      (finding) => finding.code === 'recipe.action_not_declared_by_manifest',
    ),
  );
});

test('native reason lookup uses the actual iOS input label with its placeholder', () => {
  const label = 'Issue reason for source-notification';
  const nodes = [
    { type: 'Other', label: `${label} Reason`, ref: 'e30' },
    { type: 'TextView', label: `${label} Reason`, ref: 'e31' },
    { type: 'Button', label: 'Looks right for source-notification', ref: 'e32' },
  ];
  assert.equal(d05NativeControl(nodes, label)?.ref, 'e31');
  assert.equal(d05NativeControl(nodes, 'Looks right for source-notification')?.ref, 'e32');
  assert.equal(d05NativeControl(nodes, 'Issue reason for a-different-claim'), undefined);
});

test('cleanup follows known gateway writes only after an independent matching read', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'owned.json');
  const owner = new D05FixtureOwner([root]);
  await owner.write(file, JSON.stringify({ id: 'owned', receipts: [] }));
  const updated = { id: 'owned', receipts: ['confirmed', 'rejected'] };
  await writeFile(file, JSON.stringify(updated));
  await assert.rejects(
    owner.followRunWrites(file, { id: 'owned', receipts: [] }),
    /independent gateway read/,
  );
  await owner.followRunWrites(file, { ...updated, liveRecipeContext: {} });
  await owner.cleanup();
  assert.equal(await optionalStat(file), undefined);
});

test('following gateway writes cannot adopt an existing file or delete later foreign contents', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'owned.json');
  const value = { id: 'owned' };
  await writeFile(file, JSON.stringify(value));
  const owner = new D05FixtureOwner([root]);
  await assert.rejects(owner.followRunWrites(file, value), /newly owned/);
  const created = path.join(root, 'created.json');
  await owner.write(created, JSON.stringify({ id: 'created' }));
  await owner.followRunWrites(created, { id: 'created' });
  await writeFile(created, 'later foreign content');
  await owner.cleanup();
  assert.equal(await readFile(created, 'utf8'), 'later foreign content');
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(value));
});
