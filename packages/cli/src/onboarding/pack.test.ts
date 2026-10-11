import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  decideAddAction,
  expandPackVars,
  hashPackDir,
  projectName,
  projectShortName,
  validatePackDir as validateInstalledPackDir,
  validatePackJson,
} from './pack.js';

// Admission fixtures must not inherit the operator's configured pool.
const validatePackDir = (dir: string, pool = join(dir, '.test-pool')) =>
  validateInstalledPackDir(dir, pool);

const VALID_PACK = {
  name: 'example-app',
  projects: [{ dir: 'projects/example-app-farm', platform: 'cli', slots: 1 }],
};

function writePackDir(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fs-pack-'));
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ ...VALID_PACK, ...overrides }, null, 2));
  mkdirSync(join(dir, 'projects', 'example-app-farm'), { recursive: true });
  writeFileSync(
    join(dir, 'projects', 'example-app-farm', 'project.json'),
    JSON.stringify({ name: 'example-app-farm' }),
  );
  mkdirSync(join(dir, 'projects', 'example-app-farm', 'setup'), { recursive: true });
  writeFileSync(
    join(dir, 'projects', 'example-app-farm', 'setup', 'cli.sh'),
    '#!/usr/bin/env bash\n',
  );
  return dir;
}

test('validatePackJson accepts a minimal pack', () => {
  assert.deepEqual(validatePackJson(VALID_PACK), []);
});

test('validatePackJson reports actionable errors', () => {
  assert.deepEqual(validatePackJson([]), ['pack.json must be a JSON object']);
  const errors = validatePackJson({
    name: 'Bad Name',
    projects: [{ dir: 'example-app-farm', platform: 'CLI!', slots: 0 }],
    hooks: { unknown_hook: 'true' },
  });
  assert.ok(errors.some((e) => e.includes(`'name'`)));
  assert.ok(errors.some((e) => e.includes(`'dir' must be projects/<kebab-case-name>`)));
  assert.ok(errors.some((e) => e.includes(`'platform'`)));
  assert.ok(errors.some((e) => e.includes(`'slots'`)));
  assert.ok(errors.some((e) => e.includes('unknown hook')));
});

test('validatePackDir validates project dirs and name match', () => {
  const dir = writePackDir();
  const { pack, errors } = validatePackDir(dir);
  assert.deepEqual(errors, []);
  assert.equal(pack?.name, 'example-app');

  writeFileSync(
    join(dir, 'projects', 'example-app-farm', 'project.json'),
    JSON.stringify({ name: 'wrong-name' }),
  );
  const mismatched = validatePackDir(dir);
  assert.ok(mismatched.errors.some((e) => e.includes(`must match the dir name`)));

  const empty = mkdtempSync(join(tmpdir(), 'fs-pack-'));
  assert.ok(validatePackDir(empty).errors[0].includes('no pack.json'));
});

test('validatePackDir requires a setup script for each declared platform', () => {
  const dir = writePackDir({
    projects: [{ dir: 'projects/example-app-farm', platform: 'ios', slots: 1 }],
  });
  const result = validatePackDir(dir);
  assert.ok(result.errors.some((e) => e.includes('setup/ios.sh not found')));
});

test('projectName / projectShortName derive from the pack dir entry', () => {
  const proj = { dir: 'projects/example-app-farm', platform: 'cli', slots: 1 };
  assert.equal(projectName(proj), 'example-app-farm');
  assert.equal(projectShortName(proj), 'example-app');
  assert.equal(projectShortName({ ...proj, short: 'ex' }), 'ex');
  assert.equal(projectShortName({ ...proj, dir: 'projects/tool' }), 'tool');
});

test('hashPackDir is deterministic and content-sensitive', () => {
  const dir = writePackDir();
  const first = hashPackDir(dir);
  assert.equal(hashPackDir(dir), first);
  writeFileSync(join(dir, 'projects', 'example-app-farm', 'extra.txt'), 'change');
  assert.notEqual(hashPackDir(dir), first);
});

test('decideAddAction: add for new, noop for unchanged, repair for changed', () => {
  assert.equal(decideAddAction(undefined, 'abc'), 'add');
  assert.equal(decideAddAction('abc', 'abc'), 'noop');
  assert.equal(decideAddAction('abc', 'def'), 'repair');
});

test('expandPackVars substitutes {{workspace}}', () => {
  assert.equal(
    expandPackVars('{{workspace}}/repos/src and {{workspace}}/runs', { workspace: '/w' }),
    '/w/repos/src and /w/runs',
  );
});

test('project add pack admission rejects a private template before registration', (t) => {
  const root = writePackDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const templates = join(root, 'projects/example-app-farm/templates');
  mkdirSync(templates);
  writeFileSync(join(templates, 'task.md'), 'Validate task\n~/xreview/private-helper\n');
  const result = validatePackDir(root);
  assert.equal(result.pack, null);
  assert.match(result.errors[0], /^projects\/example-app-farm\/templates\/task.md:2:.*pool\/slot/);
});

test('pack admission uses the target workspace pool for literal node references', (t) => {
  const root = writePackDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pool = join(root, 'target-pool');
  mkdirSync(pool);
  writeFileSync(
    join(pool, 'worker.json'),
    JSON.stringify({ machine: 'worker-z', host: 'worker-z.example' }),
  );
  const template = join(root, 'projects/example-app-farm/setup/cli.sh');
  writeFileSync(template, 'ssh worker-z true');
  assert.match(validatePackDir(root, pool).errors[0], /setup\/cli.sh:1:.*pool\/slot/);
});

test('pack validation refuses malformed recipe sources before any provider import', (t) => {
  const dir = writePackDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'projects', 'example-app-farm', 'project.json');
  for (const recipe of [
    { provider: { module: 1 } },
    {
      provider: { module: 'provider.mjs' },
      libraries: [{ name: 'team', source: 'library', owner: '' }],
    },
    {
      provider: { module: 'provider.mjs' },
      libraries: [
        { name: 'team', source: 'a', owner: 'x' },
        { name: 'team', source: 'b', owner: 'y' },
      ],
    },
  ]) {
    writeFileSync(file, JSON.stringify({ name: 'example-app-farm', recipe }));
    const result = validatePackDir(dir);
    assert.equal(result.pack, null);
    assert.ok(result.errors.some((error) => error.includes('recipe.')));
  }
  writeFileSync(
    file,
    JSON.stringify({ name: 'example-app-farm', recipe: { provider: { module: 'provider.mjs' } } }),
  );
  assert.deepEqual(validatePackDir(dir).errors, []);
});
