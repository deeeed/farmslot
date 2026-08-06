#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-review-recovery-'));
const runsDir = path.join(tempRoot, 'runs');
const poolDir = path.join(tempRoot, 'pool');
const projectsDir = path.join(tempRoot, 'projects');
const repoDir = path.join(tempRoot, 'repo');
const taskDir = path.join(repoDir, 'tasks', 'review-recovery');
const artifactsDir = path.join(taskDir, 'artifacts');
const runId = 'b983afc6-review-recovery-terminal-contract';
const slotId = 'review-recovery-validation';
const project = 'review-recovery-validation';
const startedAt = '2026-08-06T10:00:00.000Z';
const completedAt = '2026-08-06T10:40:00.000Z';
const evidencePath = path.join(
  root,
  'docs',
  'operations',
  'evidence',
  'runner-validate-review-recovery-terminal-contract.json',
);

process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
process.env.FARMSLOT_RUNS_DIR = runsDir;
process.env.FARMSLOT_POOL_DIR = poolDir;
process.env.FARMSLOT_PROJECTS_DIR = projectsDir;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function writeText(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, 'utf-8');
}

function terminalSignal(status: 'complete' | 'failed' | 'blocked'): object {
  return {
    role: 'self-review',
    status,
    outcome: status === 'complete' ? 'success' : status === 'blocked' ? 'partial' : 'failure',
    disposition: status === 'complete' ? 'fixed' : status,
    timestamp: completedAt,
  };
}

function seedScenario(): void {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'review-recovery@example.test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Review Recovery Validation'], { cwd: repoDir });
  writeText(path.join(repoDir, 'README.md'), '# Review recovery validation\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'test: seed review recovery validation'], { cwd: repoDir });

  writeJson(path.join(poolDir, 'review-recovery.json'), {
    machine: 'review-recovery-validation',
    project,
    platform: 'cli',
    host: 'localhost',
    ssh_user: process.env.USER || 'dev',
    os: process.platform === 'darwin' ? 'darwin' : 'linux',
    slots: [{ id: slotId, enabled: true, repo: repoDir, session: slotId }],
  });
  writeJson(path.join(projectsDir, project, 'project.json'), {
    name: project,
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    self_review: { enabled: true, max_retries: 0, review_timeout_min: 1 },
  });

  writeText(path.join(taskDir, 'TASK.md'), '# Review recovery terminal contract\n');
  for (const id of ['rev-missing', 'rev-invalid', 'rev-valid', 'rev-failed', 'rev-blocked']) {
    writeText(path.join(taskDir, `SELF-REVIEW.${id}.md`), `# Reviewer ${id}\n`);
  }
  writeText(
    path.join(artifactsDir, 'review-feedback.rev-missing.md'),
    '# Review\n\nVERDICT: PASS\n',
  );
  writeJson(path.join(taskDir, 'SELF-REVIEW.rev-missing-SIGNAL.json'), terminalSignal('complete'));
  writeText(
    path.join(artifactsDir, 'review-feedback.rev-invalid.md'),
    '# Review\n\nVERDICT: PASS\n',
  );
  writeText(path.join(artifactsDir, 'review-result.rev-invalid.json'), '{"verdict":"pass"}\n');
  writeJson(path.join(taskDir, 'SELF-REVIEW.rev-invalid-SIGNAL.json'), terminalSignal('complete'));

  writeText(path.join(artifactsDir, 'review-feedback.rev-valid.md'), '# Review\n\nVERDICT: PASS\n');
  writeJson(path.join(artifactsDir, 'review-result.rev-valid.json'), {
    schemaVersion: 1,
    verdict: 'pass',
    issues: [],
  });
  writeJson(path.join(taskDir, 'SELF-REVIEW.rev-valid-SIGNAL.json'), terminalSignal('complete'));
  writeJson(path.join(taskDir, 'SELF-REVIEW.rev-failed-SIGNAL.json'), terminalSignal('failed'));
  writeJson(path.join(taskDir, 'SELF-REVIEW.rev-blocked-SIGNAL.json'), terminalSignal('blocked'));

  const contexts = [
    { id: 'rev-missing', artifactScope: 'independent-review-1' },
    { id: 'rev-invalid', artifactScope: 'independent-review-2' },
    { id: 'rev-valid', artifactScope: 'independent-review-3' },
    { id: 'rev-failed', artifactScope: 'independent-review-4' },
    { id: 'rev-blocked', artifactScope: 'independent-review-5' },
  ].map(({ id, artifactScope }) => ({
    id,
    role: 'self-review',
    label: id,
    status: 'working',
    slotId,
    runId,
    taskFile: `tasks/review-recovery/SELF-REVIEW.${id}.md`,
    signalFile: `tasks/review-recovery/SELF-REVIEW.${id}-SIGNAL.json`,
    reviewResultFile: `artifacts/review-result.${id}.json`,
    artifactScope,
    runner: 'scripted',
    model: null,
    startedAt,
    attemptStartedAt: startedAt,
    updatedAt: startedAt,
  }));
  const step = (name: string, status: string) => ({ name, status });
  writeJson(path.join(runsDir, `${runId}.json`), {
    id: runId,
    familyId: runId,
    parentRunId: null,
    familyRootTicketOrPr: 'RECOVERY-497',
    lane: 'validation',
    variant: null,
    flowType: 'fix-bug',
    mode: 'validation',
    status: 'blocked',
    project,
    ticketOrPr: 'RECOVERY-497',
    slotId,
    branch: 'fix/review-recovery-terminal-contract',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [
      step('find-slot', 'done'),
      step('grade', 'done'),
      step('write-task', 'done'),
      step('prepare', 'done'),
      step('dispatch', 'done'),
      step('monitor', 'done'),
      step('self-review', 'done'),
      step('complete', 'done'),
      step('human-gate', 'running'),
      step('finalize', 'pending'),
      step('ci-watch', 'pending'),
    ],
    decisions: [
      {
        id: 'gate-before-recovery',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: completedAt,
      },
    ],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: 'scripted',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    agentContexts: contexts,
    engineState: {
      publishGate: {
        independentReviews: [],
        reviewRecovery: {
          status: 'watching',
          attempts: 38,
          startedAt,
          updatedAt: completedAt,
          nextRetryAt: '2026-08-06T10:45:00.000Z',
        },
      },
    },
    createdAt: startedAt,
    startedAt,
    updatedAt: completedAt,
  });
}

function contractSnapshot(run: any): object {
  const recovery = run.engineState?.publishGate?.reviewRecovery;
  const reviewIds = (run.engineState?.publishGate?.independentReviews ?? []).map(
    (review: any) => review.id,
  );
  const contextStatus = Object.fromEntries(
    (run.agentContexts ?? []).map((context: any) => [context.id, context.status]),
  );
  const gateReplayed = (run.recoveryAttempts ?? []).some(
    (attempt: any) => attempt.stepName === 'human-gate' && attempt.triggeredBy === 'auto-recovery',
  );
  const contractSatisfied =
    recovery?.status === 'operator-required' &&
    recovery.attempts === 38 &&
    recovery.startedAt === startedAt &&
    recovery.nextRetryAt === undefined &&
    recovery.lastError?.includes('rev-missing') &&
    recovery.lastError?.includes('rev-invalid') &&
    !recovery.lastError?.includes('rev-failed') &&
    !recovery.lastError?.includes('rev-blocked') &&
    reviewIds.includes('independent-review-3') &&
    contextStatus['rev-missing'] === 'blocked' &&
    contextStatus['rev-invalid'] === 'blocked' &&
    contextStatus['rev-valid'] === 'complete' &&
    contextStatus['rev-failed'] === 'failed' &&
    contextStatus['rev-blocked'] === 'blocked' &&
    gateReplayed;
  return {
    contractSatisfied,
    recovery,
    reviewIds,
    contextStatus,
    gateReplayed,
  };
}

async function main(): Promise<void> {
  seedScenario();
  const { getRun, loadAllRuns } = await import('../../../services/gateway/src/runs/store.js');
  const { recoverActiveRuns } =
    await import('../../../services/gateway/src/run-engine/orchestrator.js');

  await loadAllRuns();
  const beforeRun = structuredClone(getRun(runId));
  assert.ok(beforeRun);
  const before = contractSnapshot(beforeRun);
  assert.equal((before as any).contractSatisfied, false, 'scenario must fail before recovery');

  await recoverActiveRuns();
  const afterRun = getRun(runId);
  assert.ok(afterRun);
  const after = contractSnapshot(afterRun);
  assert.equal((after as any).contractSatisfied, true, 'production recovery must satisfy contract');

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scenario: 'review-recovery-terminal-contract',
    sourceFailureRunId: 'b983afc6-f9f3-4e6f-a365-2ff612f545fc',
    gatewayPath: [
      'recoverActiveRuns',
      'recoverInflightPublicationReviews',
      'runReplayStep(human-gate, auto-recovery)',
    ],
    fixture: {
      missingTerminal: 'complete + Markdown + missing structured JSON',
      invalidTerminal: 'complete + Markdown + invalid structured JSON',
      validSibling: 'complete + Markdown + valid structured JSON',
      failedSibling: 'failed + missing structured JSON',
      blockedSibling: 'blocked + missing structured JSON',
    },
    before,
    after,
    pass: true,
  };
  writeJson(evidencePath, evidence);
  console.log(`PASS review recovery terminal contract: ${path.relative(root, evidencePath)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });
