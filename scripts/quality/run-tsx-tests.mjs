#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const cwdFlagIndex = args.indexOf('--cwd');
const tsconfigFlagIndex = args.indexOf('--tsconfig');
const nodeTest = args.includes('--node-test');
const cwd = cwdFlagIndex >= 0 ? resolve(args[cwdFlagIndex + 1] ?? '.') : process.cwd();
const tsconfig = tsconfigFlagIndex >= 0 ? args[tsconfigFlagIndex + 1] : undefined;
const roots = args.filter((arg, index) => {
  if (arg === '--cwd' || arg === '--tsconfig' || arg === '--node-test') return false;
  if (cwdFlagIndex >= 0 && index === cwdFlagIndex + 1) return false;
  if (tsconfigFlagIndex >= 0 && index === tsconfigFlagIndex + 1) return false;
  return true;
});

if (roots.length === 0) {
  console.error(
    'Usage: run-tsx-tests.mjs [--cwd <dir>] [--tsconfig <file>] [--node-test] <dir-or-test-file> [...]',
  );
  process.exit(1);
}

function collectTests(root) {
  const absolute = resolve(cwd, root);
  const stat = statSync(absolute);
  if (stat.isFile()) return absolute.endsWith('.test.ts') ? [absolute] : [];
  const tests = [];
  for (const entry of readdirSync(absolute)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '.turbo')
      continue;
    tests.push(...collectTests(resolve(absolute, entry)));
  }
  return tests;
}

const tests = [...new Set(roots.flatMap(collectTests))].sort();
if (tests.length === 0) {
  console.error(`No .test.ts files found under: ${roots.join(', ')}`);
  process.exit(1);
}

// Git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (etc.) into hook
// environments (pre-commit, pre-push). A test that spawns `git` to build a
// temp-dir fixture inherits these and — despite setting its own `cwd` — operates
// on the REAL repo: bogus `init` commits land on the checked-out branch and
// `git init --bare` flips `core.bare`. Strip the location vars so fixture git
// commands stay confined to their own working directory. No-op outside hooks.
const GIT_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];
const childEnv = { ...process.env };
for (const key of GIT_LOCATION_ENV) delete childEnv[key];

function run(args) {
  const result = spawnSync('yarn', args, {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function usesModuleMocks(testPath) {
  return readFileSync(testPath, 'utf8').includes('mock.module(');
}

const moduleMockTests = nodeTest ? tests : tests.filter(usesModuleMocks);
const regularTests = nodeTest ? [] : tests.filter((test) => !usesModuleMocks(test));

if (moduleMockTests.length > 0) {
  run([
    'exec',
    'node',
    '--import',
    'tsx',
    '--experimental-test-module-mocks',
    '--test',
    ...moduleMockTests.map((test) => relative(cwd, test)),
  ]);
}

for (const test of regularTests) {
  const command = ['exec', 'tsx'];
  if (tsconfig) command.push('--tsconfig', tsconfig);
  command.push(relative(cwd, test));
  run(command);
}
