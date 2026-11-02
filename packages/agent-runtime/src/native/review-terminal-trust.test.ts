import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));

test('a scripts-only frozen terminal bundle refuses unsafe account hooks before launch and trusts nothing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'frozen-terminal-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = path.join(root, 'inputs/runtime/node_modules/@farmslot/agent-runtime/scripts');
  await cp(scripts, staged, { recursive: true });
  await assert.rejects(readFile(path.join(staged, '../dist/native/registry.js')), /ENOENT/);
  // The OS sandbox has its own enforcement proofs; this case tests frozen dependency closure.
  await writeFile(
    path.join(staged, 'review-filesystem.cjs'),
    "module.exports={sandbox:async()=>({temporaryDirectory:process.env.FIXTURE_OUTPUT,sandbox:{executable:'/usr/bin/env',args:[]}})};\n",
  );
  const owner = 'fixture-owner';
  const workspaceId = 'fixture-review';
  const workspace = path.join(
    root,
    'review-workspaces',
    createHash('sha256').update(owner).digest('hex'),
    'runs',
    workspaceId,
  );
  const source = path.join(workspace, 'source');
  const task = path.join(workspace, 'task');
  const account = path.join(root, 'account');
  const bin = path.join(root, 'bin');
  for (const directory of [source, task, account, bin]) await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(workspace, 'identity.json'),
    JSON.stringify({ owner, workspaceId, runId: workspaceId }),
    { mode: 0o600 },
  );
  const git = path.join(bin, 'git');
  await writeFile(git, '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_SOURCE"\n');
  await chmod(git, 0o700);
  const tmux = path.join(bin, 'tmux');
  await writeFile(
    tmux,
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const action=process.argv[2];if(action==='has-session')process.exit(1);if(action!=='new-session')throw Error('Unexpected terminal operation');if(fs.existsSync(path.join(process.env.GROK_HOME,'trusted_folders.toml')))throw Error('A review checkout stays untrusted');fs.writeFileSync(process.env.FIXTURE_LAUNCH,'verified');\n`,
  );
  await chmod(tmux, 0o700);
  const executable = path.join(root, 'configured-grok');
  await writeFile(
    path.join(bin, 'grok'),
    '#!/bin/sh\necho "Wrong executable on PATH" >&2\nexit 23\n',
    { mode: 0o700 },
  );
  await writeFile(
    executable,
    `#!${process.execPath}\nif(!process.argv.includes('inspect')||!process.argv.includes('--json'))throw Error('Expected account inspection');process.stdout.write(process.env.FIXTURE_INSPECTION);\n`,
    { mode: 0o700 },
  );
  const launched = path.join(root, 'launch');
  const launch = (inspection: object) =>
    spawnSync(
      process.execPath,
      [
        path.join(staged, 'review-terminal.cjs'),
        JSON.stringify({
          action: 'launch',
          runner: 'grok',
          executable,
          model: 'fixture-model',
          runId: workspaceId,
          workspaceId,
          session: 'fixture-review',
          cwd: source,
          task,
          runtimeRoots: [],
          environment: { set: { GROK_HOME: account }, unset: [] },
          prompt: 'Read-only review',
          command: 'true',
        }),
      ],
      {
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          GROK_HOME: account,
          FIXTURE_OUTPUT: task,
          FIXTURE_SOURCE: source,
          FIXTURE_LAUNCH: launched,
          FIXTURE_INSPECTION: JSON.stringify(inspection),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
  const refused = launch({
    grokVersion: '1.0.52',
    hooks: [{ event: 'session_start', target: 'node pr-script.cjs' }],
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Grok review refused:.*allow_managed_hooks_only/);
  for (const file of [
    launched,
    path.join(account, 'trusted_folders.toml'),
    path.join(task, '.terminal-launch.json'),
  ])
    await assert.rejects(readFile(file), /ENOENT/);
  const result = launch({
    grokVersion: '1.0.52',
    hooks: [],
    permissions: { enforced: [{ setting: 'nonManagedHooks', enabled: false }] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(launched, 'utf8'), 'verified');
  assert.equal(JSON.parse(result.stdout).runner, 'grok');
});
