import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  listPackOwnedEntries,
  packMachineNames,
  validatePackFilePortability,
  validatePackPortability,
} from '../../src/node/pack-portability.js';

test('pack policy rejects private paths and fixed nodes with line and fix guidance', () => {
  for (const reference of [
    '~/xreview/bin/helper',
    '${HOME}/xreview/a',
    '~/dev/app',
    '$HOME/dev/app',
    '${HOME}/dev/app',
    '/Users/$USER/dev/app',
    '/Users/${USER}/dev/app',
    'PATH=/usr/bin:/Users/operator/bin',
    '>/Users/operator/output',
    '/Volumes/data/app',
    'slot-lock run',
    '/Users/operator/dev/app',
    'file:///Users/operator/dev/app.git',
    '/home/operator/app',
    '/var/root/app',
    'C:\\Users\\operator\\app',
    'ssh worker-a.local',
    '--machine worker-a',
    'HOST=worker-b',
  ]) {
    const errors = validatePackFilePortability('hooks/project.sh', `#!/bin/sh\n${reference}\n`, [
      'macpro',
      'worker-a',
      'worker-b',
    ]);
    assert.equal(errors.length, 1, reference);
    assert.match(errors[0], /^hooks\/project.sh:2: nonportable reference/);
    assert.match(errors[0], /pool\/slot \{\{placeholder\}\}/);
  }
});

test('portable pool placeholders and pack-relative hooks pass', () => {
  assert.deepEqual(
    validatePackFilePortability(
      'project.json',
      'node {{farmslot_dir}}/projects/example/scripts/project.mjs {{slot_id}}\n{{repo}}\n{{farmslot_dir}}/.config',
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
  writeFileSync(join(root, 'recipes/check.json'), '{"machine":"worker-box"}');
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

test('guard instructions, model names and hosted URL paths remain portable', () => {
  assert.deepEqual(
    validatePackFilePortability(
      'task.md',
      'Strip `/Users/` paths. Use gpt-4o-mini and https://example.test/home/docs. Refer to domains/agentic.local/foo, CLAUDE.local.agent.md and skills.local.',
      ['mini'],
    ),
    [],
  );
});

test('ownership honors a parent index and switches to nested repositories', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'pack-owner-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', parent]);
  const pack = join(parent, 'pack');
  mkdirSync(pack);
  writeFileSync(join(pack, '.gitignore'), 'tasks/\n');
  mkdirSync(join(pack, 'tasks'));
  writeFileSync(join(pack, 'tasks/report.md'), '/Users/operator/runtime');
  writeFileSync(join(pack, 'task.md'), 'portable {{repo}}');
  assert.deepEqual(validatePackPortability(pack), []);
  const child = join(pack, 'child');
  execFileSync('git', ['init', '--quiet', child]);
  writeFileSync(join(child, 'hook.sh'), 'ssh worker-box.local');
  execFileSync('git', ['-C', child, 'add', 'hook.sh']);
  execFileSync('git', [
    '-C',
    child,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'test: fixture',
  ]);
  execFileSync('git', ['-C', parent, 'add', 'pack/child']);
  assert.ok(validatePackPortability(pack).some((e) => e.startsWith('child/hook.sh:1:')));
});

test('standalone project packs skip runtime tasks while retaining templates', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pack-standalone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/report.md'), '/Users/operator/runtime');
  mkdirSync(join(root, 'templates'));
  writeFileSync(join(root, 'templates/task.md'), '{{repo}}');
  assert.deepEqual(validatePackPortability(root), []);
});

test('ordinary SSH options and URL hosts reject foreign nodes while relative namespaces pass', () => {
  for (const command of [
    'ssh -o BatchMode=yes old-worker.local true',
    "ssh -p 22 'user@old-worker.local' true",
    'ssh://git@old-worker.local/repo.git',
    'scp -i ./key file.txt user@old-worker.local:/tmp/file',
    'rsync -av ./data user@old-worker.local:/data',
  ]) {
    assert.equal(validatePackFilePortability('hooks.sh', command).length, 1, command);
  }
  for (const command of [
    'ssh example.com cat skills.local/file.md',
    'scp skills.local/file.md example.com:/tmp/file',
    'node skills.local/script.mjs',
  ])
    assert.deepEqual(validatePackFilePortability('hooks.sh', command), [], command);
});

test('pack pool identities skip malformed JSON without echoing its contents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'portable-pool-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'invalid.json'), '{"secret":"fixture-private",');
  writeFileSync(
    join(root, 'configured.json'),
    JSON.stringify({ machine: 'registered', host: 'registered.local', slots: [] }),
  );
  assert.deepEqual(packMachineNames(root), ['registered', 'registered.local']);
});

test('ordinary pool hostnames do not turn branch, mode or tool names into fixed selectors', () => {
  const names = ['main', 'dev', 'node'];
  assert.deepEqual(
    validatePackFilePortability(
      'project.json',
      '{"default_branch":"main","mode":"dev","command":"node script.js"}',
      names,
    ),
    [],
  );
  for (const value of [
    'ssh -o BatchMode=yes node true',
    '--machine dev',
    'HOST=main',
    '{"allowedMachines":["dev"]}',
  ])
    assert.equal(validatePackFilePortability('project.json', value, names).length, 1, value);
});

test('control tests remain pack-owned without treating their invalid inputs as runtime references', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'portable-control-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  writeFileSync(
    join(root, 'tests/portability.test.mjs'),
    "const badInput = '/Users/operator/app';",
  );
  assert.ok(listPackOwnedEntries(root).some((entry) => entry.rel === 'tests/portability.test.mjs'));
  assert.deepEqual(validatePackPortability(root), []);
  writeFileSync(join(root, 'tests/setup.sh'), 'cd /Users/operator/app');
  assert.equal(validatePackPortability(root).length, 1);
  writeFileSync(join(root, 'worker.test.md'), 'cd /Users/operator/app');
  assert.equal(validatePackPortability(root).length, 2);
});

test('copied packs honor their own ignore rules under an ignoring parent repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'portable-installed-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  writeFileSync(join(root, '.gitignore'), 'projects/\n');
  const pack = join(root, 'projects/example');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, '.gitignore'), 'operator.private\n');
  writeFileSync(join(pack, 'operator.private'), '/Users/operator/restored-fixture');
  writeFileSync(join(pack, 'project.json'), '{"repo":"{{repo}}"}');
  assert.deepEqual(validatePackPortability(pack), []);
  assert.ok(!listPackOwnedEntries(pack).some((entry) => entry.rel === 'operator.private'));
  writeFileSync(join(pack, 'hook.sh'), 'cd /Users/operator/app');
  assert.equal(validatePackPortability(pack).length, 1);
});
