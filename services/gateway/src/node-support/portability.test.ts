import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../core/config.js';

import { collectNodeSupportBundle } from './ensure.js';

test('gateway pack sync rejects nonportable templates even when only config is bundled', async (t) => {
  const name = `portability-test-${process.pid}-farm`;
  const root = path.join(farmslotRoot, 'projects', name);
  await mkdir(path.join(root, 'templates'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      qa: {
        default_profile: 'smoke',
        profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
      },
    }),
  );
  await writeFile(path.join(root, 'templates/task.md'), 'Run checks\nssh macwork.local\n');
  await assert.rejects(
    collectNodeSupportBundle(name, [`projects/${name}/project.json`]),
    new RegExp(`projects/${name}/templates/task.md:2:.*pool/slot`),
  );
  await assert.rejects(collectNodeSupportBundle(name, []), /templates\/task.md:2:/);
  await writeFile(path.join(root, 'templates/task.md'), 'Run {{slot_id}} checks using {{repo}}');
  assert.equal(
    (await collectNodeSupportBundle(name, [`projects/${name}/project.json`])).files.length,
    1,
  );
});

test('gateway pack sync requires QA even when config is not in the support bundle', async (t) => {
  const name = `qa-test-${process.pid}-farm`;
  const root = path.join(farmslotRoot, 'projects', name);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'project.json'), '{}');
  await assert.rejects(
    collectNodeSupportBundle(name, []),
    new RegExp(`projects/${name}/project.json:1: missing required qa flow`),
  );
});
