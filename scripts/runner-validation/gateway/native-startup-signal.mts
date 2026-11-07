// Real managed native startup and journal readback. No provider or live farm state.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { NativeSessionManager } from '../../../packages/agent-runtime/src/native/manager.js';
import { alive } from '../../../packages/agent-runtime/src/native/storage.js';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';

const execute = promisify(execFile);
const root = await realpath(await mkdtemp('/tmp/native-signal-'));
const reaper = startReaper();
reaper.path(root);
const runner = path.join(root, 'codex');
const marker = path.join(root, 'child.json');
const preload = path.join(root, 'signal.cjs');
const state = path.join(root, 'state');
await writeFile(
  runner,
  '#!' +
    process.execPath +
    '\nif(process.argv.includes("--version")){console.log("fixture 1");process.exit(0)}\nsetInterval(()=>{},1000);\n',
  { mode: 0o700 },
);
await writeFile(
  preload,
  `const cp=require('node:child_process'),fs=require('node:fs');const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,wrapper:process.pid}));process.kill(process.pid,'SIGTERM');return child;};\n`,
);
const manager = new NativeSessionManager(state);
const owner = 'startup-proof';
const cleanup = cleanupOnExit(async () => {
  try {
    let value: { pid: number; wrapper: number } | undefined;
    try {
      value = JSON.parse(await readFile(marker, 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (value) assert(Number.isSafeInteger(value.pid) && value.pid > 1);
    if (value && alive(value.pid)) {
      let command: string | undefined;
      try {
        command = (await execute('ps', ['-p', String(value.pid), '-o', 'command='])).stdout;
      } catch (error) {
        if (alive(value.pid)) throw error;
      }
      if (command !== undefined) {
        assert(command.includes(runner), 'Refuse to signal a reused fixture PID');
        try {
          process.kill(value.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
    }
    for (const session of manager.list(owner))
      await manager.closeWorker(owner, session.id, session.generation, session.workerLeaseId!);
  } finally {
    await rm(root, { recursive: true, force: true });
    reaper.done();
  }
});
try {
  const sessionId = randomUUID();
  const leaseId = randomUUID();
  await assert.rejects(
    manager.ensure(
      owner,
      { sessionId, runner: 'codex', cwd: root },
      {
        leaseId,
        executable: runner,
        safetyTier: 'full-auto',
        environment: {
          set: {
            CODEX_HOME: path.join(root, 'account'),
            NODE_OPTIONS: '--require ' + JSON.stringify(preload),
          },
          unset: [],
        },
      },
    ),
    /closed|Native runner exited/,
  );
  const child = JSON.parse(await readFile(marker, 'utf8'));
  const result = await poll(
    'managed startup cleanup receipt',
    async () => {
      const session = manager.list(owner).find((entry) => entry.id === sessionId);
      return session?.state === 'failed' && session.processStopped === true ? session : undefined;
    },
    5000,
  );
  assert.equal(result.workerLeaseId, leaseId);
  assert.equal(alive(child.pid), false);
  const journal = await readFile(path.join(state, sessionId + '.journal'), 'utf8');
  assert(journal.includes('"processStopped":true'));
  console.log(
    JSON.stringify({
      pass: true,
      sessionId,
      state: result.state,
      processStopped: result.processStopped,
      managedWorker: result.workerManaged,
      childAbsent: true,
      providerTurns: 0,
      liveFarmChanged: false,
    }),
  );
} finally {
  await cleanup();
}
