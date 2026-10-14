import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

import { NativeSessionManager } from './manager.js';
import { nativeRunnerDefinitions } from './registry.js';
import type { NativeAdapterOptions } from './types.js';

const trustScript = createRequire(import.meta.url).resolve('../../scripts/workspace-trust.cjs');

const exec = promisify(execFile);

test('review trust preserves configuration across concurrent workspaces and refuses corrupt JSON', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-trust-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.claude.json');
  await writeFile(
    file,
    JSON.stringify({ theme: 'dark', projects: { '/existing': { allowedTools: ['read'] } } }),
  );
  const seed = (checkout: string) =>
    exec(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(trustScript)}).trustClaudeWorkspace(${JSON.stringify(checkout)});`,
      ],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: directory } },
    );
  const reviews = await Promise.all(
    ['review-a', 'review-b', 'after-crash', 'review-c'].map((name) => farmSource(directory, name)),
  );
  await Promise.all(reviews.slice(0, 2).map(seed));
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.projects['/existing'], { allowedTools: ['read'] });
  assert.equal(config.projects[reviews[0]].hasTrustDialogAccepted, true);
  assert.equal(config.projects[reviews[1]].hasTrustDialogAccepted, true);
  const holder = spawn('python3', [
    '-c',
    "import fcntl,sys,signal\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\nsignal.pause()",
    file + '.farmslot-review.lock',
  ]);
  t.after(() => {
    holder.kill('SIGKILL');
  });
  const exited = once(holder, 'exit');
  await once(holder.stdout, 'data');
  holder.kill('SIGKILL');
  await exited;
  await seed(reviews[2]);
  assert.equal(
    JSON.parse(await readFile(file, 'utf8')).projects[reviews[2]].hasTrustDialogAccepted,
    true,
  );
  await writeFile(file, '{broken');
  await assert.rejects(seed(reviews[3]));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

async function farmSource(root: string, workspaceId: string) {
  const owner = 'owner';
  const source = path.join(
    root,
    'review-workspaces',
    createHash('sha256').update(owner).digest('hex'),
    'runs',
    workspaceId,
    'source',
  );
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, '..', 'identity.json'),
    JSON.stringify({ owner, workspaceId, runId: workspaceId }),
    { mode: 0o600 },
  );
  return source;
}

for (const runner of ['codex', 'grok', 'claude']) {
  test(`${runner} configures only allocator-owned source in the selected account home`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-workspace-trust-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = await farmSource(directory, 'review-"quoted]#');
    const account = path.join(directory, 'account');
    const env = {
      ...process.env,
      HOME: path.join(directory, 'ambient'),
      CODEX_HOME: account,
      GROK_HOME: account,
      CLAUDE_CONFIG_DIR: account,
    };
    const trust = nativeRunnerDefinitions[runner].trustWorkspace!;
    trust(directory, env, 'owner');
    await assert.rejects(readFile(account), /ENOENT/);
    assert.throws(() => trust(source, env, 'another-owner'), /does not match/);
    trust(source, env, 'owner');
    const file = path.join(
      account,
      runner === 'claude'
        ? '.claude.json'
        : runner === 'codex'
          ? 'config.toml'
          : 'trusted_folders.toml',
    );
    const first = await readFile(file, 'utf8');
    if (runner === 'claude')
      assert.deepEqual(
        Object.keys(JSON.parse(first).projects).sort(),
        [...new Set([source, await realpath(source)])].sort(),
      );
    else {
      assert.ok(first.includes(JSON.stringify(source)), first);
      assert.ok(
        first.includes(runner === 'codex' ? 'trust_level = "untrusted"' : 'trusted = true'),
        first,
      );
    }
    trust(source, env, 'owner');
    assert.equal(await readFile(file, 'utf8'), first);
    await assert.rejects(readFile(path.join(env.HOME, '.codex', 'config.toml')), /ENOENT/);
    await assert.rejects(readFile(path.join(env.HOME, '.grok', 'trusted_folders.toml')), /ENOENT/);
  });
}

for (const runner of ['codex', 'grok']) {
  test(`${runner} preserves multiline config and simultaneous source trust entries`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-toml-trust-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sources = await Promise.all(['one', 'two'].map((name) => farmSource(directory, name)));
    const file = path.join(directory, runner === 'codex' ? 'config.toml' : 'trusted_folders.toml');
    const prefix =
      'note = """\n[projects."not-a-table"]\ntrust_level = "untrusted"\n"""\n[other]\nsetting = true\n';
    await writeFile(file, prefix);
    const functionName =
      runner === 'codex' ? 'configureCodexReviewWorkspace' : 'trustGrokWorkspace';
    await Promise.all(
      sources.map((source) =>
        exec(
          process.execPath,
          [
            '-e',
            `require(${JSON.stringify(trustScript)}).${functionName}(${JSON.stringify(source)});`,
          ],
          { env: { ...process.env, CODEX_HOME: directory, GROK_HOME: directory } },
        ),
      ),
    );
    const content = await readFile(file, 'utf8');
    assert.ok(content.startsWith(prefix.trimEnd()), content);
    for (const source of sources) assert.ok(content.includes(JSON.stringify(source)), content);
    nativeRunnerDefinitions[runner].trustWorkspace!(
      sources[0],
      { ...process.env, CODEX_HOME: directory, GROK_HOME: directory },
      'owner',
    );
    assert.equal(await readFile(file, 'utf8'), content);
  });
}

test('native worker records farm workspace trust before startup while conversations do not', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-trust-launch-'));
  const source = await farmSource(directory, 'review-launch');
  const output = path.join(directory, 'output');
  const account = path.join(directory, 'account');
  const executable = path.join(directory, 'codex');
  await mkdir(output);
  await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.162.0"\n');
  await chmod(executable, 0o700);
  const originalHome = process.env.CODEX_HOME;
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
  process.env.CODEX_HOME = account;
  const manager = new NativeSessionManager(path.join(directory, 'state'));
  const ids: string[] = [];
  let launches = 0;
  t.after(async () => {
    for (const id of ids) await manager.close('owner', id);
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  });
  mock.method(
    nativeRunnerDefinitions.codex.adapter,
    'start',
    async (options: NativeAdapterOptions) => {
      launches += 1;
      if (launches === 1)
        await assert.rejects(readFile(path.join(account, 'config.toml')), /ENOENT/);
      else {
        const content = await readFile(path.join(account, 'config.toml'), 'utf8');
        assert.ok(content.includes(JSON.stringify(source)), content);
        const policy = options.filesystemPolicy;
        assert.ok(policy);
        assert.ok(policy.readOnlyRoots.includes(await realpath(source)));
        assert.deepEqual(policy.writableRoots, [await realpath(output)]);
      }
      return {
        nativeSessionId: `session-${launches}`,
        send: async () => {},
        respond: async () => {},
        interrupt: async () => {},
        close: async () => {},
      };
    },
  );
  const ordinary = await manager.create('owner', { runner: 'codex', cwd: source });
  ids.push(ordinary.id);
  const worker = await manager.ensure(
    'owner',
    { runner: 'codex', cwd: source, sessionId: '10000000-0000-4000-8000-000000000001' },
    {
      leaseId: '20000000-0000-4000-8000-000000000002',
      executable,
      safetyTier: 'sandboxed',
      environment: { set: { CODEX_HOME: account }, unset: [] },
      filesystemPolicy: { readOnlyRoots: [source], writableRoots: [output] },
    },
  );
  ids.push(worker.id);
  assert.equal(launches, 2);
});
