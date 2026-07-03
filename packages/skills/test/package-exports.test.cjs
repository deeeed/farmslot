#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

assert.equal(packageJson.name, '@farmslot/skills');
assert.ok(packageJson.bin['farmslot-skills']);

for (const skillName of [
  'recipe-cook',
  'recipe-quality',
  'recipe-doctor',
  'recipe-harness',
  'project-adopt',
  'interactive-operator-packets',
]) {
  assert.ok(fs.existsSync(path.join(packageRoot, 'skills', skillName, 'SKILL.md')));
}

const list = spawnSync(
  process.execPath,
  [path.join(packageRoot, 'bin', 'farmslot-skills.mjs'), 'list'],
  {
    cwd: packageRoot,
    encoding: 'utf8',
  },
);
assert.equal(list.status, 0, list.stderr || list.stdout);
assert.match(list.stdout, /recipe-cook/);

process.stdout.write('package-exports tests: ok\n');
