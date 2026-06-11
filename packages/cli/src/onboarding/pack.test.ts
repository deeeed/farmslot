import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  decideAddAction,
  expandPackVars,
  hashPackDir,
  projectName,
  projectShortName,
  validatePackDir,
  validatePackJson,
} from './pack.js';

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
