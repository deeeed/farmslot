import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireCheckoutLock,
  type CheckoutLockFailure,
  classifyLogEvent,
  color,
  colorHumanMessage,
  commandJournalPath,
  configureHarnessHost,
  gitLibraryProvenance,
  harnessExecutable,
  harnessHost,
  hostEnvName,
  indexArtifactManifest,
  JsonStreamWriter,
  missingShellLeafMessage,
  readCommandJournal,
  readContainedJsonArtifact,
  recipeEnvName,
  recipeRuntimeDir,
  recipeRuntimePath,
  recordCommandEvidence,
  redactCommandArgs,
  sourceSnapshot,
  stripAnsi,
  trackCheckoutChild,
  withCommandJournal,
  writeContainedArtifact,
} from '../src/harness/index.js';

const MM_HOST = {
  name: 'mm-harness',
  product: 'MetaMask',
  envPrefix: 'MM_HARNESS',
  recipeEnvPrefix: 'METAMASK_RECIPE',
  packageName: '@deeeed/metamask-harness',
  packageRoot: '/opt/mm-harness',
  bin: 'bin/mm-harness',
  journaledCommands: ['run', 'call', 'launch', 'fixtures'],
};

// The farmslot-recipe identity, captured before any test reconfigures the host.
const DEFAULT_HOST = harnessHost();

const roots: string[] = [];
function tempRoot(prefix = 'recipe-cli-harness-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const touchedEnv = [
  'RECIPE_RUNTIME_DIR',
  'RECIPE_COLOR',
  'NO_COLOR',
  'RECIPE_NO_COLOR',
  'MM_HARNESS_EXECUTABLE',
  'MM_HARNESS_OPERATION_ID',
  'MM_HARNESS_CHECKOUT_LOCK_TOKEN',
  'FARMSLOT_RECIPE_OPERATION_ID',
  'FARMSLOT_RECIPE_CHECKOUT_LOCK_TOKEN',
];
const savedEnv = Object.fromEntries(touchedEnv.map((name) => [name, process.env[name]]));

afterEach(() => {
  configureHarnessHost(DEFAULT_HOST);
  for (const name of touchedEnv) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('host identity', () => {
  test('defaults to farmslot-recipe and the shared runtime layout', () => {
    const host = harnessHost();
    assert.equal(host.name, 'farmslot-recipe');
    assert.equal(hostEnvName('OPERATION_ID'), 'FARMSLOT_RECIPE_OPERATION_ID');
    assert.equal(recipeEnvName('ADAPTER_INPUT'), 'RECIPE_ADAPTER_INPUT');
    assert.equal(recipeRuntimeDir(), 'temp/recipe/runtime');
    assert.ok(fs.existsSync(path.join(host.packageRoot, 'package.json')));
    assert.ok(fs.existsSync(harnessExecutable()), 'the default executable is the shipped bin');
  });

  test('a product host keeps its own names and env prefix', () => {
    configureHarnessHost(MM_HOST);
    assert.equal(hostEnvName('OPERATION_ID'), 'MM_HARNESS_OPERATION_ID');
    assert.equal(recipeEnvName('ADAPTER_INPUT'), 'METAMASK_RECIPE_ADAPTER_INPUT');
    assert.equal(harnessExecutable(), path.resolve('/opt/mm-harness/bin/mm-harness'));
    process.env.MM_HARNESS_EXECUTABLE = '/elsewhere/bin/mm-harness';
    assert.equal(harnessExecutable(), '/elsewhere/bin/mm-harness');
    assert.match(
      missingShellLeafMessage('/x/launch.sh'),
      /reinstall mm-harness \(npm i -g @deeeed\/metamask-harness\)/u,
    );
  });

  test('requires every identity field and defaults the journal to nothing', () => {
    const { journaledCommands: _journaled, ...identity } = MM_HOST;
    assert.deepEqual(configureHarnessHost(identity).journaledCommands, []);
    const { bin: _bin, ...missingBin } = MM_HOST;
    // A host that forgets a field must not compile; it would inherit farmslot-recipe's.
    // @ts-expect-error bin is required
    const misconfigured = (): unknown => configureHarnessHost(missingBin);
    assert.equal(typeof misconfigured, 'function');
  });

  test('rejects an unsafe env prefix or runtime directory', () => {
    assert.throws(
      () => configureHarnessHost({ ...MM_HOST, envPrefix: 'mm-harness' }),
      /upper-case identifier/u,
    );
    assert.throws(
      () => configureHarnessHost({ ...MM_HOST, recipeEnvPrefix: 'metamask_recipe' }),
      /recipeEnvPrefix must be an upper-case identifier/u,
    );
    process.env.RECIPE_RUNTIME_DIR = '../out';
    assert.throws(() => recipeRuntimeDir(), /unsafe path component/u);
    process.env.RECIPE_RUNTIME_DIR = '/abs';
    assert.throws(() => recipeRuntimeDir(), /non-empty relative path/u);
  });

  test('RECIPE_RUNTIME_DIR overrides the host default', () => {
    process.env.RECIPE_RUNTIME_DIR = 'custom/runtime';
    assert.equal(recipeRuntimePath('/repo', 'x.json'), '/repo/custom/runtime/x.json');
  });
});

describe('command journal', () => {
  beforeEach(() => {
    configureHarnessHost({ ...DEFAULT_HOST, journaledCommands: ['run', 'call', 'launch'] });
  });

  test('the default host journals nothing', async () => {
    configureHarnessHost(DEFAULT_HOST);
    const target = tempRoot();
    assert.equal(await withCommandJournal('run', ['run', '--target', target], async () => 0), 0);
    assert.equal(fs.existsSync(path.dirname(commandJournalPath(target))), false);
  });

  test('redacts option, assignment, URL, and structured secrets without hiding evidence', () => {
    assert.deepEqual(
      redactCommandArgs([
        '--password',
        'hunter2',
        '--token=abc',
        'payload={"seed":"words","safe":"visible"}',
        'config={"apiKey":"abc","vault":"encrypted","account":"visible"}',
        'payload=api_key=opaque-secret',
        'state=vault=opaque-vault',
        '{"password":"bare-json-secret","safe":"visible"}',
        '{"mnemonic":"standalone-secret","account":"visible"}',
        'https://user:pass@example.test/path',
        'tx=0x1234',
        '--arg=payload=api_key=x',
        '--extra=state=vault=y',
        '--target=/repo/checkout',
      ]),
      [
        '--password',
        '<redacted>',
        '--token=<redacted>',
        'payload={"seed":"<redacted>","safe":"visible"}',
        'config={"apiKey":"<redacted>","vault":"<redacted>","account":"visible"}',
        'payload=api_key=<redacted>',
        'state=vault=<redacted>',
        '{"password":"<redacted>","safe":"visible"}',
        '{"mnemonic":"<redacted>","account":"visible"}',
        'https://<redacted>@example.test/path',
        'tx=0x1234',
        '--arg=payload=api_key=<redacted>',
        '--extra=state=vault=<redacted>',
        '--target=/repo/checkout',
      ],
    );
  });

  test('writes a private pass journal with evidence and redacted arguments', async () => {
    const target = tempRoot();
    const artifacts = path.join(target, 'proof');
    const argv = ['run', '--target', target, '--artifacts-dir', artifacts, '--token', 'secret'];
    assert.equal(await withCommandJournal('run', argv, async () => 0), 0);
    const { file, record } = readCommandJournal(target);
    assert.equal(record?.command, 'run');
    assert.equal(record?.verdict, 'pass');
    assert.equal(record?.target, fs.realpathSync(target));
    assert.deepEqual(record?.evidencePaths, [artifacts]);
    assert.ok(record?.args.includes('<redacted>'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('records evidence resolved during execution and failure when execution throws', async () => {
    const target = tempRoot();
    const artifacts = path.join(target, 'resolved-proof');
    await withCommandJournal('call', ['call', 'demo', '--target', target], async () => {
      recordCommandEvidence(artifacts);
      return 0;
    });
    assert.deepEqual(readCommandJournal(target).record?.evidencePaths, [artifacts]);

    const other = tempRoot();
    await assert.rejects(
      withCommandJournal('launch', ['launch', '--target', other], async () => {
        throw new Error('boom');
      }),
      /boom/u,
    );
    assert.equal(readCommandJournal(other).record?.verdict, 'fail');
  });

  test('records running before the command settles and refuses a symlinked journal', async () => {
    const target = tempRoot();
    await withCommandJournal('run', ['run', '--target', target], async () => {
      const pending = readCommandJournal(target).record;
      assert.equal(pending?.verdict, 'running');
      assert.equal(pending?.exitCode, null);
      assert.equal(pending?.finishedAt, null);
      return 0;
    });
    const operations = path.join(path.dirname(commandJournalPath(target)), 'operations');
    assert.deepEqual(
      fs.readdirSync(operations).filter((name) => name.endsWith('.tmp')),
      [],
    );

    const linked = tempRoot();
    const file = commandJournalPath(linked);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const outside = path.join(tempRoot(), 'outside-journal.json');
    fs.writeFileSync(outside, JSON.stringify({ schemaVersion: 1, command: 'run' }));
    fs.symlinkSync(outside, file);
    assert.equal(readCommandJournal(linked).record, null);
  });

  test('rejects unsafe runtime directories and invalid journal content', () => {
    const target = tempRoot();
    assert.throws(() => commandJournalPath(target, '../escape'), /unsafe path component/u);
    const file = commandJournalPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    assert.equal(readCommandJournal(target).record, null);
  });

  test("journals only the host's commands and links nested ones through the host's env", async () => {
    configureHarnessHost(MM_HOST);
    const target = tempRoot();
    assert.equal(
      await withCommandJournal('doctor', ['doctor', '--target', target], async () => 0),
      0,
    );
    assert.equal(fs.existsSync(path.dirname(commandJournalPath(target))), false);

    await withCommandJournal('fixtures', ['fixtures', '--target', target], async () => {
      const parent = process.env.MM_HARNESS_OPERATION_ID;
      assert.ok(parent);
      assert.equal(process.env.FARMSLOT_RECIPE_OPERATION_ID, undefined);
      await withCommandJournal('launch', ['launch', '--target', target], async () => {
        assert.notEqual(process.env.MM_HARNESS_OPERATION_ID, parent);
        return 0;
      });
      assert.equal(process.env.MM_HARNESS_OPERATION_ID, parent);
      return 0;
    });
    assert.equal(process.env.MM_HARNESS_OPERATION_ID, undefined);
    assert.equal(readCommandJournal(target).record?.command, 'fixtures');
  });
});

describe('checkout lock', () => {
  test("is exclusive, re-entrant through the host's token env, and released by its owner", () => {
    configureHarnessHost(MM_HOST);
    const target = tempRoot();
    const lock = acquireCheckoutLock(target, 'launch');
    assert.ok('release' in lock);
    assert.match(process.env.MM_HARNESS_CHECKOUT_LOCK_TOKEN ?? '', /^[a-f0-9-]{36}$/u);
    // Same process, same token: a nested launcher joins the lock.
    const nested = acquireCheckoutLock(target, 'run');
    assert.ok('release' in nested);
    lock.release();
    assert.equal(fs.existsSync(lock.path), false);
    assert.equal(process.env.MM_HARNESS_CHECKOUT_LOCK_TOKEN, undefined);
  });

  test('stays busy while a tracked child outlives its owner', async () => {
    const target = tempRoot();
    const lock = acquireCheckoutLock(target, 'build');
    assert.ok('release' in lock);
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    try {
      assert.ok(child.pid);
      trackCheckoutChild(target, child.pid);
      lock.release();
      assert.equal(fs.existsSync(lock.path), true);
      delete process.env.FARMSLOT_RECIPE_CHECKOUT_LOCK_TOKEN;
      const busy = acquireCheckoutLock(target, 'launch') as CheckoutLockFailure;
      assert.match(busy.message, /busy|surviving child/u);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });
});

/** SIGKILL a process that may already be gone; anything but ESRCH is a real failure. */
function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

describe('checkout lock ownership across processes', () => {
  test('keeps an orphaned child reservation after its owner dies, then reclaims it', async () => {
    const target = tempRoot();
    const harnessModule = new URL('../src/harness/index.ts', import.meta.url).href;
    const childPidFile = path.join(target, 'child.pid');
    const owner = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
        import fs from 'node:fs';
        import { spawn } from 'node:child_process';
        import { acquireCheckoutLock, trackCheckoutChild } from ${JSON.stringify(harnessModule)};
        const target = process.argv[1];
        const lock = acquireCheckoutLock(target, 'build');
        if ('message' in lock) throw new Error(lock.message);
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
        child.on('spawn', () => {
          trackCheckoutChild(target, child.pid);
          fs.writeFileSync(process.argv[2], String(child.pid));
        });
        setInterval(() => {}, 1000);
      `,
        target,
        childPidFile,
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let ownerStderr = '';
    owner.stderr?.on('data', (chunk: Buffer) => {
      ownerStderr += chunk.toString();
    });
    let childPid: number | undefined;
    try {
      for (let i = 0; i < 600 && !fs.existsSync(childPidFile); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        fs.existsSync(childPidFile),
        `the lock owner never started its child: ${ownerStderr}`,
      );
      childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
      const exited = once(owner, 'exit');
      owner.kill('SIGKILL');
      await exited;
      const refused = acquireCheckoutLock(target, 'contender') as CheckoutLockFailure;
      assert.match(refused.message, /surviving child/u);
      process.kill(childPid, 'SIGKILL');
      for (let i = 0; i < 100; i += 1) {
        try {
          process.kill(childPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const reclaimed = acquireCheckoutLock(target, 'next');
      assert.ok('release' in reclaimed, 'the lock is reclaimed once the child exits');
      reclaimed.release();
    } finally {
      owner.kill('SIGKILL');
      if (childPid) killIfAlive(childPid);
    }
  });
});

describe('contained artifacts', () => {
  test('writes and reads inside artifactsDir and replaces manifest entries by path', async () => {
    const dir = tempRoot();
    await writeContainedArtifact(dir, 'perf/summary.json', '{"ok":true}', 'summary');
    assert.equal(fs.statSync(path.join(dir, 'perf/summary.json')).mode & 0o777, 0o600);
    assert.deepEqual(await readContainedJsonArtifact(dir, 'perf/summary.json', 1024, 'summary'), {
      ok: true,
    });
    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        run: 1,
        artifacts: [{ path: 'perf/summary.json', label: 'old', type: 'json' }],
      }),
    );
    await indexArtifactManifest(manifest, [
      { path: 'perf/summary.json', label: 'new', type: 'json' },
    ]);
    const indexed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      run: number;
      artifacts: Array<{ label: string }>;
    };
    assert.equal(indexed.run, 1);
    assert.deepEqual(
      indexed.artifacts.map((artifact) => artifact.label),
      ['new'],
    );
  });

  test('refuses escapes, symlinks and oversized reads', async () => {
    const dir = tempRoot();
    const outside = tempRoot();
    fs.writeFileSync(path.join(outside, 'keep.json'), '{"keep":true}');
    await assert.rejects(
      writeContainedArtifact(dir, '../x.json', '{}', 'escape'),
      /path must stay inside artifactsDir/u,
    );
    fs.symlinkSync(path.join(outside, 'keep.json'), path.join(dir, 'linked.json'));
    await assert.rejects(
      writeContainedArtifact(dir, 'linked.json', '{}', 'linked'),
      /must not be a symbolic link/u,
    );
    fs.symlinkSync(outside, path.join(dir, 'linked-dir'));
    await assert.rejects(
      writeContainedArtifact(dir, 'linked-dir/keep.json', '{}', 'parent'),
      /parent must stay inside/u,
    );
    assert.equal(fs.readFileSync(path.join(outside, 'keep.json'), 'utf8'), '{"keep":true}');
    fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify({ data: 'x'.repeat(2048) }));
    await assert.rejects(
      readContainedJsonArtifact(dir, 'big.json', 1024, 'big'),
      /bounded regular file/u,
    );
  });
});

describe('library provenance', () => {
  function git(root: string, ...args: string[]): string {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  }
  function repo(): string {
    const root = tempRoot('recipe-cli-library-');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'Test');
    return root;
  }

  test('reports the exact revision and dirty state', async () => {
    const root = repo();
    fs.mkdirSync(path.join(root, 'recipes'));
    fs.writeFileSync(path.join(root, 'recipes', 'smoke.recipe.json'), '{}\n');
    git(root, 'add', '.');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
    const revision = git(root, 'rev-parse', 'HEAD');
    assert.deepEqual(await gitLibraryProvenance(root), { revision, dirty: false });
    fs.writeFileSync(path.join(root, 'recipes', 'smoke.recipe.json'), '{"changed":true}\n');
    assert.deepEqual(await gitLibraryProvenance(root), { revision, dirty: true });
  });

  test('omits Git facts for a plain or untracked directory', async () => {
    assert.deepEqual(await gitLibraryProvenance(tempRoot()), {});
    const root = repo();
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked\n');
    git(root, 'add', 'tracked.txt');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
    const library = path.join(root, 'node_modules', 'team-library');
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(path.join(library, 'library.json'), '{}\n');
    assert.deepEqual(await gitLibraryProvenance(library), {});
    assert.deepEqual(await gitLibraryProvenance(library, sourceSnapshot(library)), {});
  });
});

describe('output', () => {
  test('JSON stream emits each event once and stops after complete', () => {
    const lines: string[] = [];
    const stream = new JsonStreamWriter('run', true, {
      write: (chunk: string) => lines.push(chunk) > 0,
    });
    stream.phase('launch');
    stream.complete('pass', 0);
    stream.emit('late');
    const events = lines.map(
      (line) => JSON.parse(line) as { event: string; command: string; phase?: string },
    );
    assert.deepEqual(
      events.map((event) => event.event),
      ['phase', 'complete'],
    );
    assert.equal(events[0]?.command, 'run');
    assert.equal(events[0]?.phase, 'launch');
  });

  test('colour honours RECIPE_COLOR and NO_COLOR', () => {
    delete process.env.NO_COLOR;
    delete process.env.RECIPE_NO_COLOR;
    process.env.RECIPE_COLOR = '1';
    const painted = color('ok', 'pass');
    assert.notEqual(painted, 'pass');
    assert.equal(stripAnsi(painted), 'pass');
    const human = colorHumanMessage('→ launch\n✓ pass\n✗ fail\n  Next: mm-harness verify');
    assert.equal(stripAnsi(human), '→ launch\n✓ pass\n✗ fail\n  Next: mm-harness verify');
    assert.ok(human.includes('\x1b['));
    process.env.NO_COLOR = '1';
    assert.equal(color('ok', 'pass'), 'pass');
    assert.equal(colorHumanMessage('  Next: mm-harness verify'), '  Next: mm-harness verify');
    assert.equal(classifyLogEvent('Module build failed'), 'err');
    assert.equal(classifyLogEvent('compiled successfully'), 'ok');
  });
});
