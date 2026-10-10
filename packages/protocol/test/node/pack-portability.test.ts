import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  validatePackFilePortability,
  validatePackPortability,
} from '../../src/node/pack-portability.js';

test('pack policy rejects private paths and fixed nodes with line and fix guidance', () => {
  for (const reference of [
    '~/xreview/bin/helper',
    '${HOME}/xreview/a',
    '/Users/operator/dev/app',
    '/home/operator/app',
    '/var/root/app',
    'C:\\Users\\operator\\app',
    'ssh macpro.local',
    'macwork',
    'mini',
  ]) {
    const errors = validatePackFilePortability('hooks/project.sh', `#!/bin/sh\n${reference}\n`);
    assert.equal(errors.length, 1, reference);
    assert.match(errors[0], /^hooks\/project.sh:2: nonportable reference/);
    assert.match(errors[0], /pool\/slot \{\{placeholder\}\}/);
  }
});

test('portable pool placeholders and pack-relative hooks pass', () => {
  assert.deepEqual(
    validatePackFilePortability(
      'project.json',
      'node {{farmslot_dir}}/projects/example/scripts/project.mjs {{slot_id}}\n{{repo}}\n${HOME}/.farmslot',
    ),
    [],
  );
});

test('pack scan checks templates, hooks, recipes and symlink targets, excluding binary and dependencies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'portable-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['templates', 'scripts', 'recipes', 'node_modules']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'templates/task.md'), 'Do work\n~/xreview/private\n');
  writeFileSync(join(root, 'scripts/hook.mjs'), "const repo='/Users/operator/repo'\n");
  writeFileSync(join(root, 'recipes/check.json'), '{"node":"macpro"}');
  writeFileSync(join(root, 'node_modules/ignored.js'), '/Users/operator/dependency');
  writeFileSync(join(root, 'image.png'), Buffer.from([0, 1, 2]));
  symlinkSync('/home/operator/private', join(root, 'private-link'));
  const errors = validatePackPortability(root);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => e.startsWith('templates/task.md:2:')));
  assert.ok(errors.some((e) => e.startsWith('scripts/hook.mjs:1:')));
  assert.ok(errors.some((e) => e.startsWith('recipes/check.json:1:')));
  assert.ok(errors.some((e) => e.startsWith('private-link:1:')));
});

test('pack scan excludes Git-ignored runtime data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'portable-git-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  writeFileSync(join(root, '.gitignore'), 'tasks/\n');
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/report.md'), '/Users/operator/runtime');
  writeFileSync(join(root, 'project.json'), '{"repo":"{{repo}}"}');
  assert.deepEqual(validatePackPortability(root), []);
});
