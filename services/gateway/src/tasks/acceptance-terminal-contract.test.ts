import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

// mock.module replaces a module wholesale, so a partial namedExports map deletes
// every export the subject's import graph still needs. The namespace imports are
// evaluated before mock.module runs, so they hold the real modules; spreading
// them keeps every export real and overrides only what these tests fix.
import * as realConfig from '../core/config.js';
import * as realExec from '../core/exec.js';

let taskDir = '';
let execCalls: string[] = [];
let checkerStdout = 'TASK_ARTIFACT_CONTRACT_PASS';

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      remoteRepo: path.dirname(taskDir),
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-acceptance-contract',
      projectName: 'farmslot',
    }),
  },
});

mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    // The remote checker is not the subject here: record that the gateway got
    // far enough to reach it, and report the prerequisite probe as missing so the
    // call returns without spawning anything.
    // The remote checker is not the subject: record the command the gateway would
    // run, and report the prerequisite probe as satisfied so the checker line is
    // the one recorded. Its own exit is faked as success.
    execOnSlot: async (_vars: unknown, command: string) => {
      execCalls.push(command);
      return { exitCode: 0, stdout: checkerStdout, stderr: '' };
    },
  },
});

const { validateTerminalSignalArtifacts } = await import('./worker-terminal-contract.js');

function writeTaskDir(options: { handoff?: string | null; require?: boolean } = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-acceptance-contract-'));
  const dir = path.join(root, 'task');
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [x] **1. record the verdicts**\n');
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      flowType: 'dev',
      requireSignal: true,
      // Enforcement is opt-in; these tests are about the gate, so most of them
      // declare it. The default-off case has its own test below.
      ...(options.require === false ? {} : { acceptance: { require: true } }),
    })}\n`,
  );
  const handoff =
    options.handoff === undefined
      ? JSON.stringify({ task: { acceptanceCriteria: ['one', 'two'] } })
      : options.handoff;
  if (handoff !== null) writeFileSync(path.join(dir, 'inputs', 'handoff.json'), handoff);
  taskDir = dir;
  return root;
}

async function validate(disposition?: string) {
  return validateTerminalSignalArtifacts(
    'slot-acceptance-contract',
    path.join(taskDir, 'SIGNAL.json'),
    {
      status: 'complete',
      outcome: 'success',
      timestamp: new Date().toISOString(),
      ...(disposition ? { disposition } : {}),
    } as Parameters<typeof validateTerminalSignalArtifacts>[2],
    path.join(taskDir, 'CHECKLIST.md'),
  );
}

test('a checker PASS without declared CI results fails closed with the selected paths', async () => {
  for (const projection of ['', '\nTASK_DETERMINISTIC_CHECKS []']) {
    const root = writeTaskDir({ require: false });
    const contract = path.join(taskDir, 'inputs/worker-terminal-contract.json');
    writeFileSync(
      contract,
      JSON.stringify({
        deterministicChecks: [
          {
            checklist: 'CHECKLIST.md',
            stepNumber: 17,
            reference: 'checks.unit',
            command: 'true',
          },
        ],
      }),
    );
    checkerStdout = `TASK_ARTIFACT_CONTRACT_PASS${projection}`;
    try {
      const result = await validate();
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.kind, 'infrastructure');
        assert.ok(result.message.includes(contract));
        assert.match(result.message, /check-task-artifact-contract\.mjs returned/);
        assert.match(result.message, /declares 1 check/);
        assert.doesNotMatch(result.message, /Update the Farmslot runtime/);
      }
    } finally {
      checkerStdout = 'TASK_ARTIFACT_CONTRACT_PASS';
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('complete requires the acceptance ledger; no-change does not', async () => {
  const root = writeTaskDir({ require: true });
  execCalls = [];
  try {
    const complete = await validate();
    assert.equal(complete.ok, true);
    assert.equal(execCalls.length, 2, 'prerequisite probe, then the checker');
    assert.match(execCalls[1], /--require-acceptance-status/);

    // `no-change` says there was nothing to do: criteria it never touched are not
    // a skipped verdict, and failing it would strand the run.
    execCalls = [];
    const noChange = await validate('already_fixed');
    assert.equal(noChange.ok, true);
    assert.doesNotMatch(execCalls[1], /--require-acceptance-status/);
    assert.match(execCalls[1], /--terminal no-change/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a blocked signal is not an artifact-contract subject at all', async () => {
  const root = writeTaskDir();
  execCalls = [];
  try {
    const blocked = await validateTerminalSignalArtifacts(
      'slot-acceptance-contract',
      path.join(taskDir, 'SIGNAL.json'),
      {
        status: 'blocked',
        reason: 'needs a device',
        timestamp: new Date().toISOString(),
      } as Parameters<typeof validateTerminalSignalArtifacts>[2],
      path.join(taskDir, 'CHECKLIST.md'),
    );
    assert.equal(blocked.ok, true);
    assert.equal(execCalls.length, 0, 'a blocked signal runs no artifact check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a handoff that cannot be read fails a completion closed, naming the file', async () => {
  const root = writeTaskDir({ handoff: '{ not json', require: true });
  execCalls = [];
  try {
    const verdict = await validate();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.kind, 'artifact');
    assert.match(verdict.ok === false ? verdict.message : '', /invalid .*handoff\.json/);
    assert.match(verdict.ok === false ? verdict.message : '', /acceptance criteria/);
    assert.equal(execCalls.length, 0, 'the checker is never reached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task with no criteria completes without the acceptance flag', async () => {
  const root = writeTaskDir({ handoff: JSON.stringify({ task: { title: 'no criteria' } }) });
  execCalls = [];
  try {
    const verdict = await validate();
    assert.equal(verdict.ok, true);
    assert.doesNotMatch(execCalls[1], /--require-acceptance-status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without the project opt-in the gateway leaves enforcement to the current checker', async () => {
  // The state every farm is in until its templates write a ledger: a ticket with
  // acceptance criteria, no ledger on disk, and no `acceptance.require` in the
  // contract. This mocked command-builder test checks only the compatibility flag;
  // the real current checker refuses the missing ledger, proved through the CLI.
  const root = writeTaskDir({ require: false });
  execCalls = [];
  try {
    const verdict = await validate();
    assert.equal(verdict.ok, true);
    assert.doesNotMatch(execCalls[1], /--require-acceptance-status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without the opt-in the current checker owns unreadable handoff refusal', async () => {
  // This mocked command-builder test observes no compatibility flag. The
  // current checker, tested through the public CLI, rejects this unreadable handoff.
  const root = writeTaskDir({ handoff: '{ not json', require: false });
  execCalls = [];
  try {
    const verdict = await validate();
    assert.equal(verdict.ok, true);
    assert.doesNotMatch(execCalls[1], /--require-acceptance-status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal artifact success needs no local parity projection for a retained contract', async () => {
  for (const projection of ['', '\nTASK_DETERMINISTIC_CHECKS []']) {
    const root = writeTaskDir({ require: false });
    writeFileSync(
      path.join(taskDir, 'inputs/worker-terminal-contract.json'),
      JSON.stringify({
        deterministicChecks: [
          {
            checklist: 'CHECKLIST.md',
            stepNumber: 1,
            reference: 'ci.local_check',
            command: 'exit 91',
          },
        ],
      }),
    );
    checkerStdout = `TASK_ARTIFACT_CONTRACT_PASS${projection}`;
    try {
      assert.equal((await validate()).ok, true);
    } finally {
      checkerStdout = 'TASK_ARTIFACT_CONTRACT_PASS';
      rmSync(root, { recursive: true, force: true });
    }
  }
});
