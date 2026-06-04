import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { execLocal } from '../core/exec.js';
import {
  buildSourceDiffFilter,
  isSourceCodePath,
  SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT,
  SOURCE_DIFF_FILTER_PATHSPEC_LIMIT,
  sourceCodeGitPathspecs,
} from '../core/source-diff-filter.js';
import { DEFAULT_HARNESS_ROOT } from '../projects/harness-root.js';

import {
  cappedGitDiffCommand,
  cappedRunSourceDiffCommand,
  contributionDiffBaseSpec,
  quotedPathspecArgs,
  runSourceDiffNumstatCommand,
} from './diff-artifacts.js';
import { makeRun } from './test-fixtures.js';

test('isSourceCodePath accepts source/config files and rejects binary assets', () => {
  assert.equal(isSourceCodePath('src/path with spaces.ts'), true);
  assert.equal(isSourceCodePath('src/{old name.ts => new name.ts}'), true);
  assert.equal(isSourceCodePath('package.json'), true);
  assert.equal(isSourceCodePath('Dockerfile'), true);
  assert.equal(isSourceCodePath('yarn.lock'), false);
  assert.equal(isSourceCodePath('packages/app/pnpm-lock.yaml'), false);
  assert.equal(isSourceCodePath('assets/logo.png'), false);
  assert.equal(isSourceCodePath('recordings/demo.mp4'), false);
  assert.equal(isSourceCodePath('build/generated.bin'), false);
  assert.equal(isSourceCodePath('.task/feat/123/TASK.md'), false);
  assert.equal(isSourceCodePath('nested/.task/feat/123/TASK.md'), false);
  assert.equal(isSourceCodePath('.task.md'), false);
});

test('source diff filter supports per-project allowlist and blocklist overrides', () => {
  const filter = buildSourceDiffFilter({
    useDefaults: false,
    allowlist: {
      extensions: ['tsx'],
      basenames: ['Appfile'],
      patterns: ['config/**/*.json'],
    },
    blocklist: {
      patterns: ['config/generated/**'],
    },
  });

  assert.equal(isSourceCodePath('src/App.tsx', filter), true);
  assert.equal(isSourceCodePath('fastlane/Appfile', filter), true);
  assert.equal(isSourceCodePath('config/mobile/settings.json', filter), true);
  assert.equal(isSourceCodePath('config/generated/settings.json', filter), false);
  assert.equal(isSourceCodePath('src/App.ts', filter), false);

  const pathspecs = sourceCodeGitPathspecs(filter);
  assert(pathspecs.includes(':(icase,glob)**/*.tsx'));
  assert(pathspecs.includes(':(icase,glob)config/**/*.json'));
  assert(pathspecs.includes(':(exclude,icase,glob)config/generated/**'));

  const blockOnlyPathspecs = sourceCodeGitPathspecs(
    buildSourceDiffFilter({ useDefaults: false, blocklist: { extensions: ['png'] } }),
  );
  assert(blockOnlyPathspecs.includes(':(glob)**'));
  assert(blockOnlyPathspecs.includes(':(exclude,icase,glob)**/*.png'));
});

test('cappedGitDiffCommand uses positional pathspec args (git diff rejects --pathspec-from-file)', () => {
  const cmd = cappedGitDiffCommand('main...HEAD', [':(glob)**/*.ts', ':(exclude,glob)**/*.gen.ts']);
  assert.equal(/--pathspec-from-file/.test(cmd), false);
  assert.equal(/--pathspec-file-nul/.test(cmd), false);
  assert.equal(cmd.includes(' main...HEAD '), true);
  assert.equal(cmd.includes(':(glob)**/*.ts'), true);
  assert.equal(cmd.includes(':(exclude,glob)**/*.gen.ts'), true);
  assert.equal(/git[^|]+ -- /.test(cmd), true);
});

test('quotedPathspecArgs single-quotes pathspec entries so :(glob) syntax survives the shell', () => {
  assert.equal(quotedPathspecArgs([]), '');
  assert.equal(quotedPathspecArgs([':(glob)**/*.ts']), `':(glob)**/*.ts'`);
  // embedded single quote in a configured pattern must not break the quoting
  assert.equal(quotedPathspecArgs([`it's.ts`]), `'it'\\''s.ts'`);
});

test('cappedGitDiffCommand and quotedPathspecArgs work against a real git binary', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-real-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (cmd: string) => execLocal(cmd, { cwd: repo, timeout: 10000 });
  await run('git init -q && git config user.email t@t && git config user.name t');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  await writeFile(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n', 'utf-8');
  await writeFile(path.join(repo, 'asset.png'), 'fake', 'utf-8');
  const initial = await run('git add -A && git commit -qm initial && git rev-parse HEAD');
  assert.equal(initial.exitCode, 0, initial.stderr);
  const baseSha = initial.stdout.trim();
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
  await writeFile(path.join(repo, 'asset.png'), 'fake-modified', 'utf-8');
  await run('git add -A && git commit -qm change');

  const range = `${baseSha}...HEAD`;
  const tsOnly: string[] = [':(glob)**/*.ts'];
  const numstat = await run(
    `git -c core.quotePath=false diff --numstat ${range} -- ${quotedPathspecArgs(tsOnly)}`,
  );
  assert.equal(numstat.exitCode, 0, numstat.stderr);
  assert.match(numstat.stdout, /^1\t1\tsrc\/a\.ts$/m);
  assert.equal(/asset\.png/.test(numstat.stdout), false);

  const diff = await run(cappedGitDiffCommand(range, tsOnly));
  assert.equal(diff.exitCode, 0, diff.stderr);
  assert.match(diff.stdout, /^diff --git a\/src\/a\.ts b\/src\/a\.ts$/m);
  assert.equal(/asset\.png/.test(diff.stdout), false);
});

test('run source diff commands include dirty worktree source and exclude task artifacts', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-dirty-source-diff-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (cmd: string) => execLocal(cmd, { cwd: repo, timeout: 10000 });
  await run('git init -q && git config user.email t@t && git config user.name t');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  const initial = await run('git add -A && git commit -qm initial && git rev-parse HEAD');
  assert.equal(initial.exitCode, 0, initial.stderr);
  const baseSha = initial.stdout.trim();

  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
  await writeFile(path.join(repo, 'src', 'new.ts'), 'export const b = 1;\n', 'utf-8');
  await mkdir(path.join(repo, '.task', 'feat', '123'), { recursive: true });
  await writeFile(path.join(repo, '.task', 'feat', '123', 'TASK.md'), 'demo task\n', 'utf-8');

  const pathspecs = sourceCodeGitPathspecs(buildSourceDiffFilter());
  const numstat = await run(runSourceDiffNumstatCommand(baseSha, pathspecs));
  assert.equal(numstat.exitCode, 0, numstat.stderr);
  assert.match(numstat.stdout, /^1\t1\tsrc\/a\.ts$/m);
  assert.match(numstat.stdout, /^1\t0\tsrc\/new\.ts$/m);
  assert.doesNotMatch(numstat.stdout, /\.task\/feat\/123\/TASK\.md/);

  const diff = await run(cappedRunSourceDiffCommand(baseSha, pathspecs));
  assert.equal(diff.exitCode, 0, diff.stderr);
  assert.match(diff.stdout, /^diff --git a\/src\/a\.ts b\/src\/a\.ts$/m);
  assert.match(diff.stdout, /^diff --git a\/src\/new\.ts b\/src\/new\.ts$/m);
  assert.doesNotMatch(diff.stdout, /\.task\/feat\/123\/TASK\.md/);
});

test('contributionDiffBaseSpec uses replay startRef instead of default branch', () => {
  const base = contributionDiffBaseSpec(
    makeRun({
      startRef: {
        requestedRef: 'b66a3c1ce4617ba9530c1ca41d5acf6deb48bddb',
        resolvedSha: 'b66a3c1ce4617ba9530c1ca41d5acf6deb48bddb',
        source: { kind: 'merged-pr', repo: 'example-org/example-browser', prNumber: 42292 },
      },
    }),
    'main',
  );

  assert.deepEqual(base, {
    baseRef: 'startRef:b66a3c1ce4617ba9530c1ca41d5acf6deb48bddb',
    commitish: 'b66a3c1ce4617ba9530c1ca41d5acf6deb48bddb',
  });
});

test('source diff filter compiles **/X globs to match root files in line with git :(glob)** pathspec', () => {
  const allowFilter = buildSourceDiffFilter({
    useDefaults: false,
    allowlist: { patterns: ['**/*.ts'] },
  });
  // Git's :(glob)**/*.ts pathspec includes root-level files. The JS matcher
  // must agree, otherwise parseGitNumstat filters back out anything Git
  // returns from the repo root, producing spurious no-source-diff snapshots
  // and dropping review-input rows for top-level changes.
  assert.equal(isSourceCodePath('foo.ts', allowFilter), true);
  assert.equal(isSourceCodePath('dir/foo.ts', allowFilter), true);
  assert.equal(isSourceCodePath('dir/sub/foo.ts', allowFilter), true);
  assert.equal(isSourceCodePath('foo.tsx', allowFilter), false);

  const blockFilter = buildSourceDiffFilter({
    useDefaults: false,
    allowlist: { extensions: ['ts'] },
    blocklist: { patterns: ['**/*.gen.ts'] },
  });
  assert.equal(isSourceCodePath('foo.gen.ts', blockFilter), false);
  assert.equal(isSourceCodePath('dir/foo.gen.ts', blockFilter), false);
  assert.equal(isSourceCodePath('foo.ts', blockFilter), true);

  const middleFilter = buildSourceDiffFilter({
    useDefaults: false,
    allowlist: { patterns: ['src/**/*.ts'] },
  });
  assert.equal(isSourceCodePath('src/foo.ts', middleFilter), true);
  assert.equal(isSourceCodePath('src/dir/foo.ts', middleFilter), true);
  assert.equal(isSourceCodePath('foo.ts', middleFilter), false);
});

test('source diff filter caps custom allowlist and blocklist entries', () => {
  const manyExtensions = Array.from(
    { length: SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT + 5 },
    (_, index) => `.x${index}`,
  );
  const tooLongPattern = `${'a'.repeat(300)}/*.ts`;
  const warn = console.warn;
  console.warn = () => {};
  let filter: ReturnType<typeof buildSourceDiffFilter>;
  try {
    filter = buildSourceDiffFilter({
      useDefaults: false,
      allowlist: {
        extensions: manyExtensions,
        patterns: [tooLongPattern, 'src/**/*.ts'],
      },
    });
  } finally {
    console.warn = warn;
  }

  assert.equal(filter.allowExtensions.size, SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT);
  assert.equal(filter.allowPatterns.includes(tooLongPattern), false);
  assert.equal(filter.allowPatterns.includes('src/**/*.ts'), true);
});

test('source diff filter treats empty allowlist with defaults disabled as allow-all plus blocklist', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const filter = buildSourceDiffFilter({
      useDefaults: false,
      allowlist: { extensions: [''], basenames: ['   '], patterns: [''] },
    });
    assert.equal(isSourceCodePath('src/App.ts', filter), true);
    assert.deepEqual(sourceCodeGitPathspecs(filter), [
      `:(exclude,icase,glob)${DEFAULT_HARNESS_ROOT}/**`,
      ':(exclude,icase,glob).task/**',
      ':(exclude,icase,glob)**/.task/**',
      ':(exclude,icase,glob).task.md',
      ':(exclude,icase,glob)**/.task.md',
      ':(glob)**',
    ]);
  } finally {
    console.warn = warn;
  }
});

test('source diff filter caps aggregate git pathspec command size', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const filter = buildSourceDiffFilter({
      useDefaults: true,
      allowlist: {
        basenames: Array.from(
          { length: SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT },
          (_, index) =>
            `VeryLongGeneratedFileName${index.toString().padStart(3, '0')}.source.config.ts`,
        ),
        patterns: Array.from(
          { length: SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT },
          (_, index) => `generated/path/${index}/**/*.ts`,
        ),
      },
      blocklist: {
        basenames: Array.from(
          { length: SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT },
          (_, index) => `BlockedGeneratedFileName${index.toString().padStart(3, '0')}.ts`,
        ),
        patterns: Array.from(
          { length: SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT },
          (_, index) => `generated/block/${index}/**/*`,
        ),
      },
    });
    const specs = sourceCodeGitPathspecs(filter);
    assert(specs.length <= SOURCE_DIFF_FILTER_PATHSPEC_LIMIT);
    assert(specs.some((spec) => spec.includes('BlockedGeneratedFileName000.ts')));
    assert(specs.some((spec) => !spec.startsWith(':(exclude,')));
  } finally {
    console.warn = warn;
  }
});

test('source diff filter never emits block-only git pathspecs when capped', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const filter = buildSourceDiffFilter({
      useDefaults: false,
      allowlist: {
        patterns: ['src/**/*.ts'],
      },
      blocklist: {
        patterns: Array.from(
          { length: SOURCE_DIFF_FILTER_CUSTOM_ENTRY_LIMIT },
          (_, index) => `${'blocked/'.repeat(16)}${index}/**/*`,
        ),
      },
    });
    const specs = sourceCodeGitPathspecs(filter);
    assert(specs.length > 0);
    assert(specs.some((spec) => !spec.startsWith(':(exclude,')));
    if (specs.length === 1) assert.equal(specs[0], ':(icase,glob)src/**/*.ts');
  } finally {
    console.warn = warn;
  }
});

test('source diff filter warns when project glob uses unsupported character-class syntax', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  let filter: ReturnType<typeof buildSourceDiffFilter>;
  try {
    filter = buildSourceDiffFilter({
      useDefaults: false,
      allowlist: { patterns: ['src/[invalid.ts'] },
    });
    assert.equal(isSourceCodePath('src/[invalid.ts', filter), false);
  } finally {
    console.warn = warn;
  }
  assert(warnings.some((message) => message.includes('unsupported character-class syntax')));
  // Surface the invalid pattern via the filter so callers can thread it into
  // diff provenance (configFallbackReason='invalid-glob-pattern') instead of
  // letting the warning stay buried in stderr.
  assert.deepEqual(filter.invalidPatterns, ['src/[invalid.ts']);
});

test('source diff filter excludes invalid block patterns from emitted git pathspecs', () => {
  // Git supports bracket character classes natively. If we passed an invalid
  // (per our matcher) block pattern through to git as a `:(exclude,...)`
  // pathspec, git would silently exclude matching source files even though
  // the JS regex was a no-op `(?!)`. Pathspec emit must drop invalid patterns.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const filter = buildSourceDiffFilter({
      useDefaults: false,
      allowlist: { extensions: ['ts'] },
      blocklist: { patterns: ['src/[ab].ts', 'src/legit/**/*'] },
    });
    assert.deepEqual(filter.invalidPatterns, ['src/[ab].ts']);
    const specs = sourceCodeGitPathspecs(filter);
    assert.equal(
      specs.some((spec) => spec.includes('[ab]')),
      false,
    );
    assert(specs.some((spec) => spec.includes('src/legit/**/*')));
  } finally {
    console.warn = warn;
  }
});

test('source diff filter excludes invalid allow patterns from emitted git pathspecs', () => {
  // Mirror of the block-pattern guard. An invalid allow pattern leaking through
  // to git would re-include paths the operator did not intend (or, more often,
  // be the only allow spec emitted, silently shrinking the diff to "matches
  // nothing"). Pathspec emit must keep allow specs valid-only too.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const filter = buildSourceDiffFilter({
      useDefaults: false,
      allowlist: { patterns: ['src/[bad].ts', 'src/legit/**/*'] },
    });
    assert.deepEqual(filter.invalidPatterns, ['src/[bad].ts']);
    const specs = sourceCodeGitPathspecs(filter);
    assert.equal(
      specs.some((spec) => spec.includes('[bad]')),
      false,
    );
    assert(specs.some((spec) => spec.includes('src/legit/**/*')));
  } finally {
    console.warn = warn;
  }
});
