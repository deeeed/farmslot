import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const pack = new URL('../../packs/siteed-web-farm/projects/siteed-web-farm/', import.meta.url);
const require = createRequire(import.meta.url);
const {
  deterministicChecks,
  lintWorkerTemplateAgainstContract,
  lintWorkerTemplateStructure,
  resolveWorkerTerminalContract,
} = require('../../packages/agent-runtime/scripts/worker-terminal-contract.cjs');

test('Siteed fixture mappings match source file and directory types', () => {
  const config = JSON.parse(readFileSync(new URL('project.json', pack), 'utf8'));
  for (const { src } of config.fixtures.templates) {
    assert.ok(statSync(new URL(`fixtures/${src}`, pack)).isFile(), `${src} must be a file`);
  }
  for (const src of ['recipe-provider']) {
    const entry = config.fixtures.directories?.find((entry) => entry.src === src);
    assert.equal(entry?.dst, `.agent/${src}`);
    assert.ok(statSync(new URL(`fixtures/${src}`, pack)).isDirectory());
  }
});

test('both Siteed checklists freeze the configured CI command instead of launching validation', () => {
  const config = JSON.parse(readFileSync(new URL('project.json', pack), 'utf8'));
  for (const [file, flow] of [
    ['dev.md', 'dev'],
    ['qa.site-build.md', 'qa'],
  ]) {
    const markdown = readFileSync(new URL(`templates/worker/${file}`, pack), 'utf8');
    const contract = deterministicChecks.freeze(
      resolveWorkerTerminalContract(config.worker_terminal, flow),
      markdown,
      'CHECKLIST.md',
      { 'ci.local_check': config.ci.local_check },
    );
    assert.equal(contract.deterministicChecks?.length, 1, file);
    assert.equal(contract.deterministicChecks[0].stepNumber, 6);
    assert.equal(contract.deterministicChecks[0].command, 'node .agent/ci-local.mjs');
    assert.deepEqual(lintWorkerTemplateAgainstContract(markdown, contract), [], file);
    assert.deepEqual(lintWorkerTemplateStructure(markdown), [], file);
    assert.doesNotMatch(markdown, /corepack yarn (?:lint|build)/);
  }
  assert.ok(
    config.fixtures.templates.some(
      ({ src, dst }) => src === 'ci-local.mjs' && dst === '.agent/ci-local.mjs',
    ),
  );
});

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'siteed-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const write = (file, content = 'export {};\n') => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const commit = () => {
    git('add', 'src', 'package.json');
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    );
  };
  git('init', '-q', '-b', 'main');
  write('src/page.tsx');
  write('src/gone.ts');
  write('package.json', '{}\n');
  commit();
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write('.agent/ci-local.mjs', readFileSync(new URL('fixtures/ci-local.mjs', pack), 'utf8'));
  write(
    '.agent/bin/corepack',
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.SITEED_CI_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.SITEED_CI_ESLINT_BIN) {
  const args = process.argv.slice(2);
  const lintArgs = args[1] === 'lint' ? ['.', ...args.slice(2)] : args.slice(3);
  const result = require('node:child_process').spawnSync(process.execPath,
    [process.env.SITEED_CI_ESLINT_BIN, ...lintArgs], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
process.exit(Number(process.env.SITEED_CI_EXIT || 0));
`,
  );
  chmodSync(path.join(root, '.agent/bin/corepack'), 0o755);
  const callsFile = path.join(root, '.agent/calls.jsonl');
  writeFileSync(callsFile, '');
  return {
    root,
    write,
    commit,
    run: (env = {}) =>
      spawnSync(process.execPath, ['.agent/ci-local.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          FARMSLOT_CI_BASE_REF: '',
          PATH: `${root}/.agent/bin:${process.env.PATH}`,
          SITEED_CI_CALLS: callsFile,
          ...env,
        },
      }),
    calls: () =>
      readFileSync(callsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test('Siteed lint selects committed, dirty and untracked source, retaining filenames with spaces', (t) => {
  const f = fixture(t);
  f.write('src/committed.ts');
  f.commit();
  f.write('src/page.tsx', 'export const changed = true;\n');
  f.write('src/space name.tsx');
  f.write('.agent/recipe-provider/provider.mjs');
  rmSync(path.join(f.root, 'src/gone.ts'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    ['yarn', 'exec', 'eslint', '--', 'src/committed.ts', 'src/page.tsx', 'src/space name.tsx'],
  ]);
});

test('Siteed runs flat-config ESLint on changed files without scanning unchanged failures', (t) => {
  const f = fixture(t);
  f.write('src/unchanged.js', 'unknownUnchangedName;\n');
  f.write(
    'eslint.config.mjs',
    "export default [{ files: ['**/*.js'], rules: { 'no-undef': 'error' } }];\n",
  );
  execFileSync('git', ['add', 'eslint.config.mjs'], { cwd: f.root });
  f.commit();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: f.root });
  f.write('src/changed file.js', 'export const answer = 42;\n');
  const eslintRequire = createRequire(
    new URL('../../apps/command-center/package.json', import.meta.url),
  );
  const bin = path.join(
    path.dirname(eslintRequire.resolve('eslint/package.json')),
    'bin/eslint.js',
  );
  const env = { SITEED_CI_ESLINT_BIN: bin };
  const result = f.run(env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  f.write('src/changed file.js', 'unknownChangedName;\n');
  const failed = f.run(env);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /unknownChangedName/);
  assert.doesNotMatch(failed.stdout, /unknownUnchangedName/);
});

test('docs, global inputs and deleted files do not fall back to a full lint or build', (t) => {
  const f = fixture(t);
  f.write('README.md', 'documentation\n');
  f.write('package.json', '{"private":true}\n');
  rmSync(path.join(f.root, 'src/gone.ts'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), []);
  assert.match(result.stdout, /full builds.*CI/);
});

test('a selected lint failure fails the local check', (t) => {
  const f = fixture(t);
  f.write('src/page.tsx', 'invalid syntax\n');
  assert.equal(f.run({ SITEED_CI_EXIT: '7' }).status, 7);
});

test('an unavailable frozen base refuses validation instead of guessing a file set', (t) => {
  const f = fixture(t);
  f.write('src/page.tsx', 'export const changed = true;\n');
  for (const base of ['missing-ref', 'package.json']) {
    assert.notEqual(f.run({ FARMSLOT_CI_BASE_REF: base }).status, 0, base);
  }
  assert.deepEqual(f.calls(), []);
});
