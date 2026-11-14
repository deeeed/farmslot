// Opt-in native-host IPC maintenance proof with an existing subscription login.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { NativeSessionClient } from '../../../packages/agent-runtime/dist/native/client.js';
import type { NativeWorkerTarget } from '../../../packages/agent-runtime/src/native/worker-launch.js';
import { cleanupOnExit, startReaper } from '../lib/isolated-stack.mts';

const output = process.env.FARMSLOT_NATIVE_COMPACTION_PROOF_OUT;
assert(output, 'Set FARMSLOT_NATIVE_COMPACTION_PROOF_OUT');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'CREATE-ONCE.json'), new Date().toISOString(), { flag: 'wx' });
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'LITELLM_API_KEY',
  'CLAUDECODE',
])
  delete process.env[key];
const executable = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
const auth = JSON.parse(execFileSync(executable, ['auth', 'status'], { encoding: 'utf8' }));
assert(auth.loggedIn && auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-compaction-proof-')));
const state = path.join(root, 'native');
await writeFile(path.join(output, 'FIXTURE.json'), JSON.stringify({ root, state }));
const owner = 'context-compaction-validation';
const client = new NativeSessionClient(state);
const sessionId = randomUUID(),
  leaseId = randomUUID();
let target: NativeWorkerTarget | undefined;
const save = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const reaper = startReaper();
reaper.path(root);
const cleanup = cleanupOnExit(async () => {
  try {
    if (target) await client.closeWorker(owner, target);
  } finally {
    const host = JSON.parse(await readFile(path.join(state, 'host.json'), 'utf8'));
    assert(
      execFileSync('ps', ['-p', String(host.pid), '-o', 'command='], { encoding: 'utf8' }).includes(
        state,
      ),
    );
    process.kill(host.pid, 'SIGTERM');
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        process.kill(host.pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break;
        throw error;
      }
      assert(Date.now() < deadline, 'Owned native host did not stop');
      await delay(50);
    }
    await rm(root, { recursive: true, force: true });
    reaper.done();
  }
});
try {
  await mkdir(path.join(root, 'source'));
  await mkdir(path.join(root, 'task'));
  const stateDirectory = client.prepareWorkerState(owner, sessionId);
  const session = await client.ensureWorker(
    owner,
    { sessionId, runner: 'claude', model: 'claude-opus-5-5', cwd: path.join(root, 'source') },
    {
      leaseId,
      executable,
      safetyTier: 'sandboxed',
      modelQuestions: 'off',
      environment: {
        set: { DISABLE_OMC: '1', DISABLE_OMX: '1' },
        unset: [
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_AUTH_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'LITELLM_API_KEY',
          'CLAUDECODE',
        ],
      },
      filesystemPolicy: {
        readOnlyRoots: [path.join(root, 'source')],
        writableRoots: [path.join(root, 'task'), stateDirectory],
      },
    },
  );
  const hostIdentity = JSON.parse(await readFile(path.join(state, 'host.json'), 'utf8'));
  reaper.group(hostIdentity.pid);
  assert(session.nativeSessionId);
  target = { sessionId, leaseId, generation: session.generation };
  const read = () =>
    client.readWorker(owner, sessionId, leaseId, undefined, undefined, session.generation);
  const turn = async (commandId: string, prompt: string) => {
    await client.sendWorker(owner, target!, commandId, prompt);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const snapshot = await read();
      const command = snapshot.commands.find((row) => row.commandId === commandId);
      if (command?.state === 'completed') return snapshot;
      assert(!['closed', 'failed'].includes(snapshot.session.state), snapshot.session.error);
      await delay(100);
    }
    throw new Error('Owned native turn timed out');
  };
  const before = await turn(
    'baseline',
    'Remember this completed review finding F1: negative amounts are accepted. No task is active. Use no tools and reply STORED.',
  );
  const request = {
    operationId: 'a'.repeat(64),
    lineageId: 'owned-native-lineage',
    packetDigest: 'b'.repeat(64),
    nativeSessionId: session.nativeSessionId,
    focus:
      'Preserve completed review finding F1 and its details. Retire completed task commands. No task is active and no tools are allowed during maintenance.',
  };
  const receipt = await client.compact(owner, target, request);
  await save('COMPACTION.json', receipt);
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.evidence?.nativeSessionId, session.nativeSessionId);
  const after = await read();
  assert.equal(after.commands.length, before.commands.length);
  assert.equal(after.session.nativeSessionId, session.nativeSessionId);
  assert.deepEqual(await client.compact(owner, target, request), receipt);
  const recalled = await turn(
    'delta',
    'What is finding F1? Use no tools. Reply with its id and description only.',
  );
  await save('RECALLED.json', recalled);
  assert(
    recalled.events
      .map((event) => event.text ?? '')
      .join('')
      .includes('negative amounts'),
  );
  await save('RESULT.json', {
    status: 'PASS',
    sessionId: session.nativeSessionId,
    receipt,
    commandsBeforeMaintenance: before.commands.length,
    commandsAfterMaintenance: after.commands.length,
    commandsAfterDelta: recalled.commands.length,
    authMethod: auth.authMethod,
    apiProvider: auth.apiProvider,
  });
} finally {
  await cleanup();
}
