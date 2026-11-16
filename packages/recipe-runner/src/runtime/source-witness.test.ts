import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  currentSourceWitness,
  preparedMetadataValue,
  preparedSourceValue,
  preparedSourceValueAsync,
  sourceGitRoot,
  withPreparedSourceWitness,
} from './source-witness.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-witness-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'checkout');
  fs.mkdirSync(root);
  const before = process.env.FARMSLOT_RECIPE_CACHE_DIR;
  process.env.FARMSLOT_RECIPE_CACHE_DIR = path.join(directory, 'cache');
  cleanup.push(() => {
    if (before === undefined) delete process.env.FARMSLOT_RECIPE_CACHE_DIR;
    else process.env.FARMSLOT_RECIPE_CACHE_DIR = before;
  });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  git('init', '-q');
  fs.writeFileSync(path.join(root, '.gitignore'), 'temp/\n.env\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'original');
  fs.mkdirSync(path.join(root, 'temp'));
  git('add', '.');
  git('commit', '-qm', 'fixture');
  let computations = 0;
  const read = (extra: string[] = []) =>
    preparedSourceValue(
      root,
      'fixture-source',
      () => {
        computations++;
        return (
          fs.readFileSync(path.join(root, 'source.txt'), 'utf8') +
          (extra.length ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '')
        );
      },
      (v) => (typeof v === 'string' ? v : undefined),
      extra,
    );
  return { root, git, read, computations: () => computations };
}

test('reuses prepared values across invocations and refreshes all three boundaries', async () => {
  const f = fixture();
  await withPreparedSourceWitness(async () => {
    const view = currentSourceWitness()!;
    for (let n = 0; n < 3; n++) {
      view.checkpoint();
      assert.equal(f.read(), 'original');
    }
    assert.equal(view.measurements.length, 3);
    assert.equal(f.computations(), 1);
  });
  await withPreparedSourceWitness(async () => {
    assert.equal(f.read(), 'original');
  });
  assert.equal(f.computations(), 1);
});

test('detects unstaged edits even when mtime is restored', async () => {
  const f = fixture();
  await withPreparedSourceWitness(async () => {
    assert.equal(f.read(), 'original');
    const file = path.join(f.root, 'source.txt');
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'modified');
    fs.utimesSync(file, stat.atime, stat.mtime);
    currentSourceWitness()!.checkpoint();
    assert.equal(f.read(), 'modified');
    assert.equal(f.computations(), 2);
  });
});

test('notices new untracked directories and deletion', async () => {
  const f = fixture();
  await withPreparedSourceWitness(async () => {
    f.read();
    fs.mkdirSync(path.join(f.root, 'new'));
    fs.writeFileSync(path.join(f.root, 'new/file.txt'), 'new');
    currentSourceWitness()!.checkpoint();
    f.read();
    assert.equal(f.computations(), 2);
    fs.unlinkSync(path.join(f.root, 'new/file.txt'));
    currentSourceWitness()!.checkpoint();
    f.read();
    assert.equal(f.computations(), 3);
  });
});

test('binds ignored input bytes separately from Git status', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, '.env'), 'first');
  await withPreparedSourceWitness(async () => {
    assert.equal(f.read(['.env']), 'originalfirst');
    fs.writeFileSync(path.join(f.root, '.env'), 'other');
    currentSourceWitness()!.checkpoint();
    assert.equal(f.read(['.env']), 'originalother');
  });
});

test('old run history neither invalidates nor enlarges a source view', async () => {
  const f = fixture();
  await withPreparedSourceWitness(async () => {
    f.read();
    const first = currentSourceWitness()!.measurements[0];
    const history = path.join(f.root, 'temp/runs');
    fs.mkdirSync(history);
    for (let n = 0; n < 200; n++) fs.writeFileSync(path.join(history, n + '.json'), '{}');
    currentSourceWitness()!.checkpoint();
    f.read();
    const second = currentSourceWitness()!.measurements[1];
    assert.equal(f.computations(), 1);
    assert.equal(second.files, first.files);
    assert.equal(second.directories, first.directories);
  });
});

test('HEAD and index changes invalidate prepared values', async () => {
  const f = fixture();
  await withPreparedSourceWitness(async () => {
    f.read();
    f.git('commit', '--allow-empty', '-qm', 'new HEAD');
    currentSourceWitness()!.checkpoint();
    f.read();
    assert.equal(f.computations(), 2);
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'staged');
    f.git('add', 'source.txt');
    currentSourceWitness()!.checkpoint();
    assert.equal(f.read(), 'staged');
    assert.equal(f.computations(), 3);
  });
});

test('physical worktree discovery follows linked roots without a process', () => {
  const f = fixture();
  const linked = path.join(path.dirname(f.root), 'linked');
  f.git('worktree', 'add', '--detach', linked);
  fs.mkdirSync(path.join(linked, 'nested'));
  assert.equal(sourceGitRoot(path.join(linked, 'nested')), fs.realpathSync(linked));
  assert.equal(sourceGitRoot(path.join(f.root, 'temp')), fs.realpathSync(f.root));
});

test('ignored package delivery remains bound inside a repository', async () => {
  const f = fixture();
  f.git('config', 'core.excludesFile', '/dev/null');
  fs.appendFileSync(path.join(f.root, '.gitignore'), 'node_modules/\n');
  const pkg = path.join(f.root, 'node_modules/runner');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"runner","version":"1.0.0"}');
  const file = path.join(pkg, 'runner.js');
  fs.writeFileSync(file, 'first');
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        pkg,
        'delivery',
        () => fs.readFileSync(file, 'utf8'),
        (v) => (typeof v === 'string' ? v : undefined),
      );
    assert.equal(read(), 'first');
    fs.writeFileSync(file, 'other');
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), 'other');
  });
});

test('repository-local external config includes invalidate reuse', async () => {
  const f = fixture();
  const config = path.join(path.dirname(f.root), 'external.gitconfig');
  fs.writeFileSync(config, '[remote "origin"]\nurl = first\n');
  f.git('config', 'include.path', config);
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        f.root,
        'origin',
        () => f.git('config', '--get', 'remote.origin.url').toString().trim(),
        (v) => (typeof v === 'string' ? v : undefined),
      );
    assert.equal(read(), 'first');
    fs.writeFileSync(config, '[remote "origin"]\nurl = other\n');
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), 'other');
  });
});

test('transitive symbolic refs invalidate even without worktree or index changes', async () => {
  const f = fixture();
  const head = f.git('rev-parse', 'HEAD').toString().trim();
  f.git('symbolic-ref', 'refs/heads/alias', 'refs/heads/master');
  const branch = f.git('symbolic-ref', 'HEAD').toString().trim();
  f.git('symbolic-ref', 'refs/heads/alias', branch);
  f.git('symbolic-ref', 'HEAD', 'refs/heads/alias');
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        f.root,
        'head',
        () => f.git('rev-parse', 'HEAD').toString().trim(),
        (v) => (typeof v === 'string' ? v : undefined),
      );
    assert.equal(read(), head);
    const next = f
      .git('commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'new metadata only')
      .toString()
      .trim();
    f.git('update-ref', branch, next);
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), next);
  });
});

test('an alternate index is part of the effective metadata witness', async () => {
  const f = fixture();
  const original = process.env.GIT_INDEX_FILE;
  const alternate = path.join(path.dirname(f.root), 'alternate-index');
  fs.copyFileSync(path.join(f.root, '.git/index'), alternate);
  process.env.GIT_INDEX_FILE = alternate;
  cleanup.push(() => {
    if (original === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = original;
  });
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        f.root,
        'status',
        () => f.git('status', '--porcelain').toString(),
        (v) => (typeof v === 'string' ? v : undefined),
      );
    assert.equal(read(), '');
    f.git('read-tree', '--empty');
    currentSourceWitness()!.checkpoint();
    assert.match(read(), /D\s+source.txt/u);
  });
});

test('embedded repositories retain their own ignore rules and source changes', async () => {
  const f = fixture();
  const nested = path.join(f.root, 'nested');
  fs.mkdirSync(nested);
  f.git('-C', nested, 'init', '-q');
  fs.writeFileSync(path.join(nested, '.gitignore'), 'temp/\nnode_modules/\n');
  fs.writeFileSync(path.join(nested, 'source.txt'), 'original');
  fs.mkdirSync(path.join(nested, 'temp'));
  fs.mkdirSync(path.join(nested, 'node_modules'));
  fs.writeFileSync(path.join(nested, 'temp', 'seed.json'), '{}');
  fs.writeFileSync(path.join(nested, 'node_modules', 'seed.js'), 'dependency');
  f.git('-C', nested, 'add', '.');
  f.git('-C', nested, 'commit', '-qm', 'nested fixture');
  f.git('add', 'nested');
  await withPreparedSourceWitness(async () => {
    f.read();
    const view = currentSourceWitness()!;
    const first = view.measurements.reduce((sum, item) => sum + item.files, 0);
    for (let n = 0; n < 100; n++) {
      fs.writeFileSync(path.join(nested, 'temp', n + '.json'), '{}');
      fs.writeFileSync(path.join(nested, 'node_modules', n + '.js'), 'dependency');
    }
    view.checkpoint();
    f.read();
    assert.equal(f.computations(), 1);
    assert.equal(
      view.measurements.slice(2).reduce((sum, item) => sum + item.files, 0),
      first,
    );
    fs.writeFileSync(path.join(nested, 'source.txt'), 'changed');
    view.checkpoint();
    f.read();
    assert.equal(f.computations(), 2);
  });
});

test('raw filename bytes participate in the witness', async (t) => {
  const f = fixture();
  const file = Buffer.concat([Buffer.from(f.root + path.sep), Buffer.from([0xff])]);
  try {
    fs.writeFileSync(file, 'first');
  } catch (error) {
    if (['EILSEQ', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Filesystem requires UTF-8 filenames');
      return;
    }
    throw error;
  }
  await withPreparedSourceWitness(async () => {
    f.read();
    fs.writeFileSync(file, 'other');
    currentSourceWitness()!.checkpoint();
    f.read();
    assert.equal(f.computations(), 2);
  });
});

test('an async result cannot populate a later source checkpoint', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decode = (value: unknown) => (typeof value === 'string' ? value : undefined);
  await withPreparedSourceWitness(async () => {
    const pending = preparedSourceValueAsync(
      f.root,
      'delayed',
      async () => {
        const value = f.read();
        await gate;
        return value;
      },
      decode,
    );
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'modified');
    currentSourceWitness()!.checkpoint();
    assert.equal(f.read(), 'modified');
    assert.ok(release);
    release();
    assert.equal(await pending, 'original');
    assert.equal(
      await preparedSourceValueAsync(f.root, 'delayed', async () => f.read(), decode),
      'modified',
    );
  });
});

test('Git resolves quoted global includes and their inline comments', async () => {
  const f = fixture();
  const globalConfig = path.join(path.dirname(f.root), 'global.gitconfig');
  const include = path.join(path.dirname(f.root), 'extra config');
  fs.writeFileSync(globalConfig, '[include]\n path = "extra config" # include comment\n');
  fs.writeFileSync(include, '[remote "origin"]\n url = first\n');
  const original = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  cleanup.push(() => {
    if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = original;
  });
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        f.root,
        'origin',
        () => f.git('config', '--get', 'remote.origin.url').toString().trim(),
        (value) => (typeof value === 'string' ? value : undefined),
      );
    assert.equal(read(), 'first');
    fs.writeFileSync(include, '[remote "origin"]\n url = other\n');
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), 'other');
  });
});

test('a symlinked alternate index follows the target identity', async () => {
  const f = fixture();
  const alternate = path.join(path.dirname(f.root), 'index-target');
  const alias = path.join(path.dirname(f.root), 'index-link');
  fs.copyFileSync(path.join(f.root, '.git/index'), alternate);
  fs.symlinkSync(alternate, alias);
  const original = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alias;
  cleanup.push(() => {
    if (original === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = original;
  });
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        f.root,
        'index',
        () => f.git('ls-files', '--stage').toString(),
        (value) => (typeof value === 'string' ? value : undefined),
      );
    const initial = read();
    execFileSync('git', ['read-tree', '--empty'], {
      cwd: f.root,
      env: { ...process.env, GIT_INDEX_FILE: alternate },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    currentSourceWitness()!.checkpoint();
    assert.notEqual(read(), initial);
  });
});

test('ignored extra files are length-framed before reuse', async () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.root, '.gitignore'), '.env.local\n');
  const files = ['.env', '.env.local'];
  const write = (values: string[]) =>
    files.forEach((file, i) => fs.writeFileSync(path.join(f.root, file), values[i]!));
  const first = ['VALUE=a', 'VALUE=b.env.localVALUE=c'];
  const second = ['VALUE=a.env.localVALUE=b', 'VALUE=c'];
  write(first);
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedSourceValue(
        f.root,
        'two-env-files',
        () => JSON.stringify(files.map((file) => fs.readFileSync(path.join(f.root, file), 'utf8'))),
        (value) => (typeof value === 'string' ? value : undefined),
        files,
      );
    assert.equal(read(), JSON.stringify(first));
    write(second);
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), JSON.stringify(second));
  });
});

test('replacement-ref layouts retain fresh producers without a tree witness', async () => {
  const f = fixture();
  await withPreparedSourceWitness(async () => {
    assert.equal(f.read(), 'original');
    fs.mkdirSync(path.join(f.root, '.git/refs/replace'));
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'changed');
    currentSourceWitness()!.checkpoint();
    assert.equal(f.read(), 'changed');
    assert.ok(
      currentSourceWitness()!.fallbacks.some((entry) => entry.reason === 'unsupported-git-layout'),
    );
  });
});

test('metadata-only projections never walk generated output history', async () => {
  const f = fixture();
  f.git('config', 'remote.origin.url', 'https://example.invalid/first');
  const output = path.join(f.root, 'unignored-output');
  fs.mkdirSync(output);
  await withPreparedSourceWitness(async () => {
    const read = () =>
      preparedMetadataValue(
        f.root,
        'origin',
        () => f.git('config', '--get', 'remote.origin.url').toString().trim(),
        (value) => (typeof value === 'string' ? value : undefined),
      );
    assert.equal(read(), 'https://example.invalid/first');
    for (let n = 0; n < 100; n++) fs.writeFileSync(path.join(output, n + '.json'), '{}');
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), 'https://example.invalid/first');
    assert.equal(currentSourceWitness()!.measurements.length, 0);
    f.git('config', 'remote.origin.url', 'https://example.invalid/other');
    currentSourceWitness()!.checkpoint();
    assert.equal(read(), 'https://example.invalid/other');
  });
});

for (const kind of ['ignore', 'attributes'])
  test(`default user Git ${kind} bytes invalidate reuse`, async () => {
    const f = fixture();
    const config = path.join(path.dirname(f.root), 'config');
    fs.mkdirSync(path.join(config, 'git'), { recursive: true });
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.XDG_CONFIG_HOME = config;
    const global = path.join(config, 'empty-config');
    fs.writeFileSync(global, '');
    process.env.GIT_CONFIG_GLOBAL = global;
    cleanup.push(() => {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    });
    const file = path.join(config, 'git', kind);
    if (kind === 'ignore') fs.writeFileSync(path.join(f.root, 'scratch'), 'untracked');
    fs.writeFileSync(file, kind === 'ignore' ? 'scratch\n' : '*.txt -text\n');
    await withPreparedSourceWitness(async () => {
      const read = () =>
        preparedSourceValue(
          f.root,
          kind,
          () =>
            f
              .git(
                ...(kind === 'ignore'
                  ? ['status', '--porcelain']
                  : ['check-attr', 'text', '--', 'source.txt']),
              )
              .toString(),
          (value) => (typeof value === 'string' ? value : undefined),
        );
      const before = read();
      fs.writeFileSync(file, kind === 'ignore' ? '' : '*.txt text\n');
      currentSourceWitness()!.checkpoint();
      assert.notEqual(read(), before);
    });
  });

for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'])
  test(`cache write ${code} retains fresh reads`, async (t) => {
    const f = fixture();
    const original = fs.writeFileSync;
    t.mock.method(
      fs,
      'writeFileSync',
      (
        file: fs.PathOrFileDescriptor,
        data: Parameters<typeof fs.writeFileSync>[1],
        options?: Parameters<typeof fs.writeFileSync>[2],
      ) => {
        if (String(file).includes(path.sep + 'prepared-sources' + path.sep))
          throw Object.assign(new Error('refused cache'), { code });
        return original(file, data, options);
      },
    );
    await withPreparedSourceWitness(async () => {
      assert.equal(f.read(), 'original');
      fs.writeFileSync(path.join(f.root, 'source.txt'), 'changed');
      currentSourceWitness()!.checkpoint();
      assert.equal(f.read(), 'changed');
      assert.ok(
        currentSourceWitness()!.fallbacks.some((entry) => entry.reason === 'cache-unavailable'),
      );
    });
  });
