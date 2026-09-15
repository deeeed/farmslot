import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexNativeAdapter } from './codex.js';
import { NativeSessionManager } from './manager.js';

// A protocol contract regression fixture. Production sandbox enforcement has a separate live gate.
async function fixture(confirm: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'native-filesystem-contract-'));
  const executable = join(root, 'runner');
  const requests = join(root, 'requests.jsonl');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');
 if (message.id === undefined) return;
 const result = ['thread/start', 'thread/resume'].includes(message.method) ? {
  thread: {id:'thread'}, activePermissionProfile: {id:${JSON.stringify(confirm ? 'farmslot-read-only-source' : ':workspace')}}
 } : {};
 process.stdout.write(JSON.stringify({id:message.id,result}) + '\\n');
});\n`,
  );
  await chmod(executable, 0o755);
  return { root, executable, requests };
}

test('source policy omits legacy writable cwd, pins exact output roots and refuses unconfirmed profile', async () => {
  for (const confirm of [true, false]) {
    const f = await fixture(confirm);
    let session;
    try {
      const operation = codexNativeAdapter.start(
        {
          cwd: f.root,
          executable: f.executable,
          safetyTier: 'sandboxed',
          filesystemPolicy: { readOnlyRoots: [f.root], writableRoots: [`${f.root}-output`] },
        },
        () => {},
      );
      if (confirm) session = await operation;
      else await assert.rejects(operation, /did not confirm/);
      const messages = (await readFile(f.requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const request = messages.find((message) => message.method === 'thread/start').params;
      assert.equal(request.cwd, f.root);
      assert.equal(request.approvalPolicy, 'never');
      assert.equal(request.sandbox, undefined);
      assert.deepEqual(request.config['permissions.farmslot-read-only-source'].filesystem, {
        '/': 'read',
        [`${f.root}-output`]: 'write',
      });
      assert.equal(
        messages.some((message) => message.method === 'turn/start'),
        false,
      );
    } finally {
      await session?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('filesystem policy requires a known supported native version', () => {
  assert.equal(
    codexNativeAdapter.filesystemPolicyUnavailableReason!('codex-cli 0.154.0'),
    undefined,
  );
  assert.match(
    codexNativeAdapter.filesystemPolicyUnavailableReason!('codex-cli 0.153.0')!,
    /0.154.0/,
  );
  assert.match(codexNativeAdapter.filesystemPolicyUnavailableReason!('unversioned')!, /0.154.0/);
});

test('native manager rejects symlink output aliases and grants covering its private state before launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-policy-paths-'));
  const source = join(root, 'source');
  const state = join(root, 'state');
  const alias = join(root, 'output-alias');
  const executable = join(root, 'runner');
  try {
    await mkdir(source);
    await symlink(source, alias);
    await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.154.0"\n');
    await chmod(executable, 0o755);
    const manager = new NativeSessionManager(state);
    for (const output of [alias, state]) {
      await assert.rejects(
        manager.ensure(
          'owner',
          {
            sessionId: '10000000-0000-4000-8000-000000000001',
            runner: 'codex',
            cwd: source,
          },
          {
            leaseId: '20000000-0000-4000-8000-000000000002',
            executable,
            safetyTier: 'sandboxed',
            environment: { set: {}, unset: [] },
            filesystemPolicy: { readOnlyRoots: [source], writableRoots: [output] },
          },
        ),
        /must not overlap/,
      );
    }
    assert.deepEqual(manager.list('owner'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a source policy supports exact saved-session recovery and does not advertise relocation', async () => {
  const f = await fixture(true);
  const source = join(f.root, 'source');
  const output = join(f.root, 'output');
  await mkdir(source);
  await mkdir(output);
  const manager = new NativeSessionManager(join(f.root, 'state'));
  const sessionId = '10000000-0000-4000-8000-000000000001';
  const launch = {
    leaseId: '20000000-0000-4000-8000-000000000002',
    executable: f.executable,
    safetyTier: 'sandboxed' as const,
    environment: { set: {}, unset: [] },
    filesystemPolicy: { readOnlyRoots: [source], writableRoots: [output] },
  };
  try {
    const info = await manager.ensure('owner', { sessionId, cwd: source, runner: 'codex' }, launch);
    assert.equal(info.capabilities.resumeAcrossWorkspaces, false);
    await manager.close('owner', sessionId);
    const resumed = await manager.resumeWorker(
      'owner',
      {
        sessionId,
        cwd: source,
        runner: 'codex',
        resumeSessionId: info.nativeSessionId,
        generation: info.generation,
        commandId: 'resume-command',
      },
      launch,
    );
    assert.equal(resumed.nativeSessionId, info.nativeSessionId);
    assert.notEqual(resumed.generation, info.generation);
    assert.equal(resumed.workerLeaseId, launch.leaseId);
    assert.equal(resumed.capabilities.resumeAcrossWorkspaces, false);
  } finally {
    await manager.close('owner', sessionId);
    await rm(f.root, { recursive: true, force: true });
  }
});
