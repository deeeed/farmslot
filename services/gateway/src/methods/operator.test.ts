// operator.test.ts — read-only operator intelligence helper checks
// Usage: tsx services/gateway/src/methods/operator.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { farmslotRoot } from '../fleet/state.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { isReadableRunPreviewPath, runRecoveryProposal } from './operator.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`${GREEN}PASS${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}FAIL${RESET} ${name}: ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

await test('run context preview paths stay inside farmslot root', () => {
  assert(
    isReadableRunPreviewPath(path.join(farmslotRoot, 'tasks/example/TASK.md')),
    'tasks path should be readable',
  );
  assert(
    !isReadableRunPreviewPath(path.join(farmslotRoot, 'docs/README.md')),
    'non-task repo path should not be readable',
  );
  assert(
    !isReadableRunPreviewPath(path.resolve(farmslotRoot, '..', 'sibling-cache', 'TASK.md')),
    'sibling path should not be readable',
  );
  assert(
    !isReadableRunPreviewPath('/tmp/farmslot-dev.log'),
    'external log should not be readable through run previews',
  );
});

async function cleanupRun(runId: string, taskDir?: string): Promise<void> {
  try {
    updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(runId);
  } finally {
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
  }
}

function createRecoveryTestRun(options: { withArtifact?: boolean; failedDetail?: string } = {}) {
  const taskDir = path.join(
    farmslotRoot,
    'tasks',
    `recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Recovery test task\n', 'utf-8');
  if (options.withArtifact) {
    writeFileSync(
      path.join(taskDir, 'artifacts', 'report.md'),
      'Result: failed\nError: dependency install timed out waiting for npm.\n',
      'utf-8',
    );
  }
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: options.failedDetail ? undefined : 'Worker exited with failure',
    taskFile,
    steps: [
      {
        name: 'prepare',
        status: 'failed',
        detail: options.failedDetail,
        startedAt: new Date().toISOString(),
      },
    ],
  });
  return { run, taskDir };
}

await test('run recovery proposal is ready from structured failed run evidence', async () => {
  const { run, taskDir } = createRecoveryTestRun({
    withArtifact: true,
    failedDetail: 'prepare failed after npm timeout',
  });
  try {
    const { proposal } = await runRecoveryProposal({ runId: run.id, stepName: 'prepare' });
    assert(proposal.status === 'ready', `expected ready, got ${proposal.status}`);
    assert(proposal.target.runId === run.id, 'target run id mismatch');
    assert(proposal.target.stepName === 'prepare', 'target step missing');
    assert(
      proposal.evidence.some((e) => e.source === 'task-artifact'),
      'missing artifact evidence',
    );
    assert(proposal.nextSteps.length <= 3, 'too many next steps');
    assert(
      proposal.nextSteps.every(
        (step) => (step.kind === 'prompt' || step.kind === 'read') && step.safety === 'read-only',
      ),
      'unsafe next step',
    );
    assert(
      proposal.inferenceNotes.some((note) => note.includes('Logs were not used')),
      'missing structured-before-logs inference note',
    );
  } finally {
    await cleanupRun(run.id, taskDir);
  }
});

await test('run recovery proposal returns insufficient evidence without a cause', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-thin`,
  });
  try {
    updateRun(run.id, {
      status: 'blocked',
      error: undefined,
      taskFile: null,
      steps: [{ name: 'monitor', status: 'running' }],
      decisions: [],
    });
    const { proposal } = await runRecoveryProposal({ runId: run.id });
    assert(
      proposal.status === 'insufficient-evidence',
      `expected insufficient-evidence, got ${proposal.status}`,
    );
    assert(proposal.confidence === 'low', 'thin evidence should be low confidence');
  } finally {
    await cleanupRun(run.id);
  }
});

await test('run recovery proposal reads registered log evidence for log-backed failed steps', async () => {
  const oldExtraLogDirs = process.env.FARMSLOT_EXTRA_LOG_DIRS;
  const logDir = mkdtempSync(path.join(tmpdir(), 'farmslot-recovery-log-test-'));
  const logPath = path.join(logDir, 'prepare.log');
  writeFileSync(
    logPath,
    [
      'prepare started',
      'Error: registered log root cause token=ghp_abcdefghijklmnopqrstuvwxyz',
      'x'.repeat(30_000),
      'Error: SHOULD_NOT_READ_LATE',
    ].join('\n'),
    'utf-8',
  );
  process.env.FARMSLOT_EXTRA_LOG_DIRS = logDir;

  const { run, taskDir } = createRecoveryTestRun();
  try {
    updateRun(run.id, {
      error: undefined,
      steps: [
        {
          name: 'prepare',
          status: 'failed',
          outputs: { exitCode: 1, failedLogPath: logPath },
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const { proposal } = await runRecoveryProposal({ runId: run.id, stepName: 'prepare' });
    const logEvidence = proposal.evidence.find((e) => e.source === 'registered-log');
    assert(proposal.status === 'ready', `expected ready, got ${proposal.status}`);
    assert(Boolean(logEvidence), 'missing registered log evidence');
    const excerpt = logEvidence?.excerpt ?? '';
    assert(excerpt.includes('registered log root cause'), `missing root cause excerpt: ${excerpt}`);
    assert(excerpt.includes('[REDACTED_GITHUB_TOKEN]'), `missing log redaction: ${excerpt}`);
    assert(!excerpt.includes('SHOULD_NOT_READ_LATE'), 'registered log read was not bounded');
    assert(
      proposal.finding.includes('registered log root cause'),
      `finding did not use log evidence: ${proposal.finding}`,
    );
    assert(
      !proposal.inferenceNotes.some((note) => note.includes('Logs were not used')),
      'incorrectly reported logs were skipped',
    );
  } finally {
    if (oldExtraLogDirs === undefined) delete process.env.FARMSLOT_EXTRA_LOG_DIRS;
    else process.env.FARMSLOT_EXTRA_LOG_DIRS = oldExtraLogDirs;
    await cleanupRun(run.id, taskDir);
    rmSync(logDir, { recursive: true, force: true });
  }
});

await test('run recovery proposal returns unavailable for unknown runs', async () => {
  const { proposal } = await runRecoveryProposal({ runId: 'missing-recovery-run' });
  assert(proposal.status === 'unavailable', `expected unavailable, got ${proposal.status}`);
  assert(proposal.evidence.length === 0, 'unavailable proposal should not fabricate evidence');
});

// US-005 — recoveryDescriptors evidence-driven proposedActions
function findDescriptor(proposal: { remediationDescriptors?: Array<{ id: string }> }, id: string) {
  return proposal.remediationDescriptors?.find((d) => d.id === id);
}

await test('recoveryDescriptors include proposedActions when evidence supports', async () => {
  // Force the conservative 'flake' bucket via step name 'run' + status 'failed' + bound slot.
  const { run, taskDir } = createRecoveryTestRun({
    withArtifact: true,
    failedDetail: 'transient connection reset',
  });
  try {
    updateRun(run.id, {
      slotId: 'runner-browser-1',
      steps: [
        {
          name: 'run',
          status: 'failed',
          detail: 'transient connection reset',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const { proposal } = await runRecoveryProposal({ runId: run.id, stepName: 'run' });
    assert(proposal.status === 'ready', `expected ready, got ${proposal.status}`);
    const descriptor = findDescriptor(
      proposal as { remediationDescriptors?: Array<{ id: string }> },
      'operator-review-step',
    ) as
      | {
          proposedActions?: Array<{ type: string; params: Record<string, unknown> }>;
          failureCategory?: string;
        }
      | undefined;
    assert(Boolean(descriptor), 'expected operator-review-step descriptor');
    assert(
      descriptor!.failureCategory === 'flake',
      `expected failureCategory=flake, got ${descriptor!.failureCategory}`,
    );
    const actions = descriptor!.proposedActions ?? [];
    assert(actions.length >= 1, 'expected at least one proposedAction');
    const replay = actions.find((a) => a.type === 'run.replayStep');
    assert(Boolean(replay), 'expected run.replayStep action');
    assert(replay!.params.runId === run.id, 'replay action runId mismatch');
    assert(replay!.params.step === 'run', 'replay action step mismatch');
  } finally {
    await cleanupRun(run.id, taskDir);
  }
});

await test('omit when failure category not in recoverable set', async () => {
  // Step name 'monitor' is not mapped by deriveFailureCategory → undefined → recoverable=false.
  const { run, taskDir } = createRecoveryTestRun({
    withArtifact: true,
    failedDetail: 'protocol violation: unexpected frame',
  });
  try {
    updateRun(run.id, {
      slotId: 'runner-browser-1',
      steps: [
        {
          name: 'monitor',
          status: 'failed',
          detail: 'protocol violation: unexpected frame',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const { proposal } = await runRecoveryProposal({ runId: run.id, stepName: 'monitor' });
    assert(proposal.status === 'ready', `expected ready, got ${proposal.status}`);
    const descriptor = findDescriptor(
      proposal as { remediationDescriptors?: Array<{ id: string }> },
      'operator-review-step',
    ) as { proposedActions?: Array<unknown> } | undefined;
    assert(Boolean(descriptor), 'expected operator-review-step descriptor');
    const actions = descriptor!.proposedActions;
    assert(
      actions === undefined || actions.length === 0,
      `expected no proposedActions, got ${JSON.stringify(actions)}`,
    );
  } finally {
    await cleanupRun(run.id, taskDir);
  }
});

await test('orphaned slot run produces slot.release proposedAction', async () => {
  const { run, taskDir } = createRecoveryTestRun({
    withArtifact: true,
    failedDetail: 'install timed out',
  });
  try {
    updateRun(run.id, {
      status: 'failed',
      slotId: 'runner-browser-2',
      steps: [
        {
          name: 'prepare',
          status: 'failed',
          detail: 'install timed out',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const { proposal } = await runRecoveryProposal({ runId: run.id, stepName: 'prepare' });
    assert(proposal.status === 'ready', `expected ready, got ${proposal.status}`);
    const release = findDescriptor(
      proposal as { remediationDescriptors?: Array<{ id: string }> },
      'release-orphaned-slot',
    ) as { proposedActions?: Array<{ type: string; params: Record<string, unknown> }> } | undefined;
    assert(Boolean(release), 'expected release-orphaned-slot descriptor');
    const action = release!.proposedActions?.find((a) => a.type === 'slot.release');
    assert(Boolean(action), 'expected slot.release action');
    assert(
      action!.params.slotId === 'runner-browser-2',
      `expected slotId runner-browser-2, got ${String(action!.params.slotId)}`,
    );
  } finally {
    await cleanupRun(run.id, taskDir);
  }
});

await test('orphaned slot release fires even when failureCategory is undefined', async () => {
  // N2 regression: slot binding is independent of WHY the step failed. A
  // 'dispatch' step has no entry in deriveFailureCategory (returns undefined),
  // but a terminal run with slotId still leaves an orphaned slot the operator
  // should be able to free. Before the fix this descriptor was suppressed.
  const { run, taskDir } = createRecoveryTestRun({ withArtifact: false });
  try {
    updateRun(run.id, {
      status: 'failed',
      slotId: 'runner-browser-3',
      steps: [
        {
          name: 'dispatch',
          status: 'failed',
          detail: 'worker exited non-zero',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const { proposal } = await runRecoveryProposal({ runId: run.id, stepName: 'dispatch' });
    assert(proposal.status === 'ready', `expected ready, got ${proposal.status}`);
    const release = findDescriptor(
      proposal as { remediationDescriptors?: Array<{ id: string }> },
      'release-orphaned-slot',
    ) as { proposedActions?: Array<{ type: string; params: Record<string, unknown> }> } | undefined;
    assert(
      Boolean(release),
      'expected release-orphaned-slot descriptor for dispatch-step failure (category=undefined)',
    );
    const action = release!.proposedActions?.find((a) => a.type === 'slot.release');
    assert(Boolean(action), 'expected slot.release action');
    assert(
      action!.params.slotId === 'runner-browser-3',
      `expected slotId runner-browser-3, got ${String(action!.params.slotId)}`,
    );
  } finally {
    await cleanupRun(run.id, taskDir);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
