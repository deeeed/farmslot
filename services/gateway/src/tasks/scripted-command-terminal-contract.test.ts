import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

// See acceptance-terminal-contract.test.ts: spread the real modules, override only
// the slot lookup and the remote exec the subject reaches.
import * as realConfig from '../core/config.js';
import * as realExec from '../core/exec.js';

let taskDir = '';
let execCalls: string[] = [];

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      remoteRepo: path.dirname(taskDir),
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-scripted-contract',
      projectName: 'farmslot',
    }),
  },
});

mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    // A worker checker run here would be the bug: record it and fail loudly.
    execOnSlot: async (_vars: unknown, command: string) => {
      execCalls.push(command);
      return { exitCode: 1, stdout: '', stderr: 'TASK_ARTIFACT_CONTRACT_FAIL\n' };
    },
  },
});

const { validateTerminalSignalArtifacts, resolveWorkerTerminalContract } =
  await import('./worker-terminal-contract.js');

// The mobile pack's worker gates, as frozen for run 935c72fd: acceptance ledger,
// project terminal artifacts and recipe evidence rules.
const mobilePackTerminalConfig = {
  acceptance: { require: true },
  complete: {
    report: 'artifacts/pr-description.md',
    artifacts: ['artifacts/learnings.md', 'artifacts/pr-description.md'],
  },
};

interface CommandResult {
  exitCode: number | null;
  timedOut?: boolean;
}

function scriptedTask(result: CommandResult | null | 'invalid'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-scripted-contract-'));
  const dir = path.join(root, 'task');
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    `${JSON.stringify(
      resolveWorkerTerminalContract(mobilePackTerminalConfig, 'dev', {
        mode: 'autonomous',
        scriptedCommand: true,
      }),
    )}\n`,
  );
  // Acceptance criteria exist, as they did on the backlog item; no ledger, no CHECKLIST.md.
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: ['Nightly report line written'] } }),
  );
  if (result !== null)
    writeFileSync(
      path.join(dir, 'artifacts', 'scripted-command-result.json'),
      result === 'invalid'
        ? '{'
        : JSON.stringify({
            commandRef: 'nightly-device-build',
            exitCode: result.exitCode,
            signal: null,
            timedOut: result.timedOut ?? false,
          }),
    );
  taskDir = dir;
  execCalls = [];
  return root;
}

function validate(status: 'complete' | 'no-change' | 'blocked' = 'complete') {
  return validateTerminalSignalArtifacts(
    'slot-scripted-contract',
    path.join(taskDir, 'SIGNAL.json'),
    {
      status,
      outcome: status === 'complete' ? 'success' : 'failure',
      disposition: status === 'complete' ? 'fixed' : 'failed',
      reason: 'scripted command result',
      timestamp: new Date().toISOString(),
    } as Parameters<typeof validateTerminalSignalArtifacts>[2],
  );
}

test('run 935c72fd shape: exit 0 with no checklist receipts completes without the worker checker', async (t) => {
  const root = scriptedTask({ exitCode: 0 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await validate(), { ok: true });
  assert.deepEqual(execCalls, [], 'no worker artifact checker runs for a scripted command');
});

test('a scripted command that failed, timed out or left no result cannot complete', async (t) => {
  for (const [result, reason] of [
    [{ exitCode: 1 }, /exited 1/],
    [{ exitCode: null, timedOut: true }, /timed out/],
    [null, /scripted-command-result\.json is missing/],
    ['invalid', /scripted-command-result\.json is invalid/],
  ] as const) {
    const root = scriptedTask(result);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outcome = await validate();
    assert.equal(outcome.ok, false, String(reason));
    assert.match(!outcome.ok ? outcome.message : '', reason);
    assert.equal(!outcome.ok && outcome.kind, 'artifact');
    assert.deepEqual(execCalls, []);
  }
});

test('a blocked scripted signal needs no result record', async (t) => {
  const root = scriptedTask(null);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await validate('blocked'), { ok: true });
});
