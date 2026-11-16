// Verifies that metroEnvFingerprint and sourceFingerprint produce byte-identical
// hashes to the old mm-harness algorithm for the same inputs, so already-recorded
// baselines on farm machines stay valid.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { metroEnvFingerprint } from '../src/metro-env.js';
import { sourceFingerprint, type SourceInputs } from '../src/source-freshness.js';

// ── Old mm-harness constants (re-stated here to pin parity) ──────────────────
const MM_SOURCE_PATHS = [
  'app',
  'locales',
  'index.js',
  'shim.js',
  'shimPerf.js',
  'ReactotronConfig.js',
  'wdyr.js',
  'app.config.js',
  'babel.config.js',
  'metro.config.js',
  'metro.transform.js',
  'package.json',
] as const;
const MM_ENV_FILES = ['.js.env', '.env', '.env.local'] as const;
const MM_METRO_ENV_VARS = [
  'SEGMENT_PROXY_URL',
  'SEGMENT_WRITE_KEY',
  'SEGMENT_FLUSH_INTERVAL',
  'SEGMENT_FLUSH_EVENT_LIMIT',
] as const;

// ── Re-implemented old algorithms inline ────────────────────────────────────

/** Inline re-implementation of mm-harness mobileMetroEnvFingerprint. */
function oldMetroEnvFingerprint(target: string): string {
  const hash = createHash('sha256');
  for (const relative of MM_ENV_FILES) {
    const absolute = path.join(target, relative);
    hash.update(`${relative}\0`);
    if (fs.existsSync(absolute)) hash.update(fs.readFileSync(absolute));
    else hash.update('<absent>');
    hash.update('\0');
  }
  for (const name of MM_METRO_ENV_VARS) {
    hash.update(`${name}\0${process.env[name] ?? '<absent>'}\0`);
  }
  return hash.digest('hex');
}

/** Inline re-implementation of mm-harness mobileSourceFingerprint. */
function oldSourceFingerprint(
  target: string,
  inputs: SourceInputs = { paths: MM_SOURCE_PATHS, envFiles: MM_ENV_FILES },
): string {
  const hash = createHash('sha256');
  const head = tryGit(target, ['rev-parse', 'HEAD']);
  if (head === null) {
    hash.update('non-git\0');
    for (const relative of inputs.paths) {
      oldHashPath(hash, target, relative);
    }
  } else {
    hash.update(head);
    hash.update(
      execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', ...inputs.paths], {
        cwd: target,
        encoding: 'buffer',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const untracked = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z', '--', ...inputs.paths],
      { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    for (const relative of untracked) {
      hash.update(`untracked\0${relative}\0`);
      hash.update(fs.readFileSync(path.join(target, relative)));
      hash.update('\0');
    }
  }
  for (const relative of inputs.envFiles) {
    const absolute = path.join(target, relative);
    hash.update(`env\0${relative}\0`);
    hash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : '<absent>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function tryGit(cwd: string, args: string[]): Buffer | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function oldHashPath(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    hash.update(`absent\0${relative}\0`);
    return;
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory()) {
    hash.update(`directory\0${relative}\0`);
    for (const child of fs.readdirSync(absolute).sort()) {
      oldHashPath(hash, root, path.join(relative, child));
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${relative}\0${fs.readlinkSync(absolute)}\0`);
    return;
  }
  hash.update(`file\0${relative}\0`);
  hash.update(fs.readFileSync(absolute));
  hash.update('\0');
}

// ── Tests ────────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-parity-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@farmslot.io'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Farmslot Test'], { stdio: 'ignore' });
  // Create an initial commit so HEAD exists.
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' });
}

describe('fingerprint parity with mm-harness algorithm', () => {
  describe('metroEnvFingerprint', () => {
    it('produces byte-identical hash to old algorithm in a non-git dir (no env files)', async () => {
      const dir = await makeTempDir();

      const oldHash = oldMetroEnvFingerprint(dir);
      const newHash = metroEnvFingerprint(dir, {
        files: [...MM_ENV_FILES],
        env: [...MM_METRO_ENV_VARS],
      });

      assert.equal(newHash, oldHash, 'hashes must be byte-identical (no env files)');
    });

    it('produces byte-identical hash to old algorithm when env files are present', async () => {
      const dir = await makeTempDir();
      await writeFile(path.join(dir, '.js.env'), 'export WATCHER_PORT="8161"\n');
      await writeFile(path.join(dir, '.env'), 'NODE_ENV=test\n');
      // .env.local is absent — both algorithms treat it as <absent>

      const oldHash = oldMetroEnvFingerprint(dir);
      const newHash = metroEnvFingerprint(dir, {
        files: [...MM_ENV_FILES],
        env: [...MM_METRO_ENV_VARS],
      });

      assert.equal(newHash, oldHash, 'hashes must be byte-identical (with env files)');
    });
  });

  describe('sourceFingerprint', () => {
    it('produces byte-identical hash to old algorithm in a non-git directory', async () => {
      const dir = await makeTempDir();
      // Write one of the known source files.
      await writeFile(path.join(dir, 'package.json'), '{"name":"test"}');

      const oldHash = oldSourceFingerprint(dir);
      const newHash = sourceFingerprint(dir, {
        paths: [...MM_SOURCE_PATHS],
        envFiles: [...MM_ENV_FILES],
      });

      assert.equal(newHash, oldHash, 'hashes must be byte-identical (non-git)');
    });

    it('produces byte-identical hash to old algorithm in a git repo with tracked files', async () => {
      const dir = await makeTempDir();
      initGitRepo(dir);
      await writeFile(path.join(dir, 'package.json'), '{"name":"test"}');
      execFileSync('git', ['-C', dir, 'add', 'package.json'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-m', 'add package.json'], { stdio: 'ignore' });

      const oldHash = oldSourceFingerprint(dir);
      const newHash = sourceFingerprint(dir, {
        paths: [...MM_SOURCE_PATHS],
        envFiles: [...MM_ENV_FILES],
      });

      assert.equal(newHash, oldHash, 'hashes must be byte-identical (git, committed file)');
    });

    it('produces byte-identical hash with untracked files and env files', async () => {
      const dir = await makeTempDir();
      initGitRepo(dir);
      // Add a tracked file.
      await writeFile(path.join(dir, 'package.json'), '{"name":"test"}');
      execFileSync('git', ['-C', dir, 'add', 'package.json'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-m', 'add package.json'], { stdio: 'ignore' });
      // Add an untracked source file and an env file.
      await writeFile(path.join(dir, 'index.js'), 'console.log("hello")');
      await writeFile(path.join(dir, '.env'), 'NODE_ENV=test\n');

      const oldHash = oldSourceFingerprint(dir);
      const newHash = sourceFingerprint(dir, {
        paths: [...MM_SOURCE_PATHS],
        envFiles: [...MM_ENV_FILES],
      });

      assert.equal(newHash, oldHash, 'hashes must be byte-identical (untracked + env file)');
    });

    it('keeps the legacy fingerprint through staged edits, renames, deletion and untracked names', async () => {
      const dir = await makeTempDir();
      initGitRepo(dir);
      fs.mkdirSync(path.join(dir, 'app'));
      fs.writeFileSync(path.join(dir, 'app', 'tracked.js'), 'before\n');
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-m', 'tracked'], { stdio: 'ignore' });
      const inputs = { paths: ['./app'], envFiles: ['.env'] };
      const check = () =>
        assert.equal(sourceFingerprint(dir, inputs), oldSourceFingerprint(dir, inputs));
      check();
      fs.writeFileSync(path.join(dir, 'app', 'tracked.js'), 'after\n');
      check();
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
      check();
      execFileSync('git', ['-C', dir, 'mv', 'app/tracked.js', 'app/renamed.js']);
      fs.writeFileSync(path.join(dir, 'app', 'new\nname.js'), 'untracked');
      check();
      fs.unlinkSync(path.join(dir, 'app', 'renamed.js'));
      fs.writeFileSync(path.join(dir, '.env'), 'changed env');
      check();
    });

    it('preserves cwd-relative paths for nested source roots', async () => {
      const dir = await makeTempDir();
      initGitRepo(dir);
      const nested = path.join(dir, 'nested');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'package.json'), '{}');
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-m', 'nested'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(nested, 'index.js'), 'untracked');
      const inputs = { paths: ['./package.json', 'index.js'], envFiles: [] };
      assert.equal(sourceFingerprint(nested, inputs), oldSourceFingerprint(nested, inputs));
    });

    it('observes new untracked and ignored env bytes on every invocation', async () => {
      const dir = await makeTempDir();
      initGitRepo(dir);
      fs.mkdirSync(path.join(dir, 'app'));
      fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
      const inputs = { paths: ['app'], envFiles: ['.env'] };
      const before = sourceFingerprint(dir, inputs);
      fs.writeFileSync(path.join(dir, 'app', 'new.js'), 'first');
      const untracked = sourceFingerprint(dir, inputs);
      assert.notEqual(untracked, before);
      assert.equal(untracked, oldSourceFingerprint(dir, inputs));
      fs.writeFileSync(path.join(dir, 'app', 'new.js'), 'second');
      assert.notEqual(sourceFingerprint(dir, inputs), untracked);
      fs.writeFileSync(path.join(dir, '.env'), 'ignored but bound');
      assert.equal(sourceFingerprint(dir, inputs), oldSourceFingerprint(dir, inputs));
    });

    it('keeps linked worktrees and source path exclusions byte-compatible', async () => {
      const dir = await makeTempDir();
      initGitRepo(dir);
      fs.mkdirSync(path.join(dir, 'app'));
      fs.writeFileSync(path.join(dir, 'app', 'kept.js'), 'tracked');
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-m', 'source'], { stdio: 'ignore' });
      const worktree = path.join(await makeTempDir(), 'linked');
      execFileSync('git', ['-C', dir, 'worktree', 'add', '--detach', worktree], {
        stdio: 'ignore',
      });
      cleanups.push(() => {
        execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', worktree]);
      });
      fs.writeFileSync(path.join(worktree, 'app', 'skip.js'), 'excluded');
      fs.writeFileSync(path.join(worktree, 'app', 'new.js'), 'included');
      const inputs = { paths: ['./app', ':(exclude)app/skip.js'], envFiles: [] };
      const before = sourceFingerprint(worktree, inputs);
      assert.equal(before, oldSourceFingerprint(worktree, inputs));
      fs.writeFileSync(path.join(worktree, 'app', 'skip.js'), 'changed excluded');
      assert.equal(sourceFingerprint(worktree, inputs), before);
      fs.symlinkSync('kept.js', path.join(worktree, 'app', 'link.js'));
      assert.equal(sourceFingerprint(worktree, inputs), oldSourceFingerprint(worktree, inputs));
    });
  });
});
