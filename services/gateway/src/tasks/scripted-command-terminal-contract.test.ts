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

const expected = { project: 'metamask-mobile-farm', commandRef: 'nightly-device-build' };

type ResultRecord = Record<string, unknown> | null | 'invalid' | 'absent';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandRef: expected.commandRef,
    project: expected.project,
    cwd: '/slot/repo',
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

function scriptedTask(result: ResultRecord, contract: 'scripted' | 'worker' = 'scripted'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-scripted-contract-'));
  const dir = path.join(root, 'task');
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    `${JSON.stringify(
      resolveWorkerTerminalContract(mobilePackTerminalConfig, 'dev', {
        mode: 'autonomous',
        ...(contract === 'scripted' ? { scriptedCommand: true as const } : {}),
      }),
    )}\n`,
  );
  // Acceptance criteria exist, as they can on a backlog item; no ledger, no CHECKLIST.md.
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: ['Nightly report line written'] } }),
  );
  if (result !== 'absent')
    writeFileSync(
      path.join(dir, 'artifacts', 'scripted-command-result.json'),
      result === 'invalid' ? '{' : JSON.stringify(result),
    );
  taskDir = dir;
  execCalls = [];
  return root;
}

function validate(
  status: 'complete' | 'no-change' | 'blocked' = 'complete',
  scripted: typeof expected | null = expected,
) {
  return validateTerminalSignalArtifacts(
    'slot-scripted-contract',
    path.join(taskDir, 'SIGNAL.json'),
    {
      status: status === 'no-change' ? 'complete' : status,
      outcome: status === 'blocked' ? 'failure' : 'success',
      disposition:
        status === 'no-change' ? 'already_fixed' : status === 'blocked' ? 'failed' : 'fixed',
      reason: 'scripted command result',
      timestamp: new Date().toISOString(),
    } as Parameters<typeof validateTerminalSignalArtifacts>[2],
    undefined,
    scripted ?? undefined,
  );
}

test('run 935c72fd shape: exit 0 with no checklist receipts completes without the worker checker', async (t) => {
  const root = scriptedTask(record());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await validate(), { ok: true });
  assert.deepEqual(execCalls, [], 'no worker artifact checker runs for a scripted command');
});

test('a run frozen with the worker contract is still judged by its command result', async (t) => {
  // Run 935c72fd itself: its contract predates the fix; replaying MONITOR must settle it.
  const root = scriptedTask(record(), 'worker');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await validate(), { ok: true });
  assert.deepEqual(execCalls, []);
});

test('a result that does not prove a successful run of this command cannot complete', async (t) => {
  const cases: Array<[ResultRecord, RegExp]> = [
    [record({ exitCode: 1 }), /exited 1/],
    [record({ exitCode: null, timedOut: true }), /timed out/],
    [record({ timedOut: undefined }), /timed out or did not record completion/],
    [record({ signal: 'SIGKILL' }), /ended by signal SIGKILL/],
    [record({ commandRef: 'other-command' }), /not for metamask-mobile-farm\/nightly-device-build/],
    [null, /not a JSON object/],
    ['absent', /scripted-command-result\.json is missing/],
    ['invalid', /scripted-command-result\.json is invalid/],
  ];
  for (const [result, reason] of cases) {
    const root = scriptedTask(result);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outcome = await validate();
    assert.equal(outcome.ok, false, String(reason));
    assert.match(!outcome.ok ? outcome.message : '', reason);
    assert.equal(!outcome.ok && outcome.kind, 'artifact');
    assert.deepEqual(execCalls, []);
  }
});

test('a scripted command run has no no-change outcome', async (t) => {
  const root = scriptedTask(record());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outcome = await validate('no-change');
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.message : '', /no no-change outcome/);
});

test('a slot contract claiming the scripted policy for any other run is refused', async (t) => {
  const root = scriptedTask(record());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outcome = await validate('complete', null);
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.message : '', /this run is not one/);
  assert.deepEqual(execCalls, []);
});

test('a blocked scripted signal needs no result record', async (t) => {
  const root = scriptedTask('absent');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await validate('blocked'), { ok: true });
});
