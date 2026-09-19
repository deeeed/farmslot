#!/usr/bin/env tsx
/**
 * E2E for the gateway side of child checklist units (ADR-060 phase 2).
 *
 * A REAL dispatch (`dispatchExecute`) puts a REAL task directory on a local pool
 * slot, a project-owned `scripted` command drives the task dir's own `./mark`
 * shim through the whole child lifecycle, and the gateway's own methods are
 * called in-process against the live files while the worker runs:
 *
 *   - `taskProgress` must show the `subtask` projection under the owning step,
 *     going running → blocked → running → complete;
 *   - `validateTerminalSignalArtifacts` must refuse a terminal signal while a
 *     child is open, naming the unit;
 *   - `refreshArtifactMirror` must leave `subtasks/<name>.worker` beside the
 *     orchestrator copy;
 *   - `collectRunSubtaskMetrics` must return one entry per registered child;
 *   - a re-stage of the mirrored task directory must NOT send `*.worker` back.
 *
 * Worker and gateway hand off through ack files so the phases are observed
 * deterministically instead of by sleeping.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Run, TaskStepSubtaskProgress } from '@farmslot/protocol';

import { dispatchExecute } from '../services/gateway/src/methods/dispatch/execute.js';
import { taskProgress } from '../services/gateway/src/methods/task.js';
import { refreshArtifactMirror } from '../services/gateway/src/run-completion/artifact-mirror.js';
import { copyTaskDirSubdirectories } from '../services/gateway/src/tasks/sidecars.js';
import { collectRunSubtaskMetrics } from '../services/gateway/src/tasks/subtask-metrics.js';
import { unwatchSlot } from '../services/gateway/src/tasks/watcher.js';
import { validateTerminalSignalArtifacts } from '../services/gateway/src/tasks/worker-terminal-contract.js';

const root = process.cwd();
const stamp = `${process.pid}-${Date.now()}`;
const slotId = `subtask-gw-${stamp}`;
const projectName = `subtask-gw-${stamp}`;
const session = slotId;
const poolFile = path.join(root, 'pool', `${slotId}.json`);
const projectDir = path.join(root, 'projects', projectName);
const taskName = `subtask-gateway-${stamp}`;
/** The orchestrator task root the gateway derives for a project (projects/<name>/tasks). */
const sourceTaskDir = path.join(projectDir, 'tasks', 'dev', taskName);
const workerTaskRel = path.join('.task', 'dev', taskName);
const workerTaskDir = path.join(root, workerTaskRel);
const skillFixture = path.join(root, 'scripts', 'fixtures', 'subtask-skill.md');
const driverScript = path.join(projectDir, 'drive-subtask.mjs');
const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;

const PARENT_CHECKLIST = [
  '# Worker: dev',
  '',
  '## Work',
  '',
  '- [ ] **1. read the task document**',
  '- [ ] **2. review the diff with the team skill**',
  '- [ ] **3. package the evidence**',
  '- [ ] **4. write the terminal signal**',
  '',
].join('\n');

const OWNING_STEP = 2;
const SECOND_STEP = 3;

function run(command: string, args: string[], options: { ignoreFailure?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'pipe', encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (!options.ignoreFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function ackPath(phase: string): string {
  return path.join(workerTaskDir, 'artifacts', `ack-${phase}`);
}

function phasePath(phase: string): string {
  return path.join(workerTaskDir, 'artifacts', `phase-${phase}`);
}

function workerLog(): string {
  const parts: string[] = [];
  for (const file of ['driver.log', 'scripted-command.stdout.txt', 'scripted-command.stderr.txt']) {
    const full = path.join(workerTaskDir, 'artifacts', file);
    if (existsSync(full)) parts.push(`--- ${file} ---\n${readFileSync(full, 'utf-8')}`);
  }
  const pane = run('tmux', ['capture-pane', '-p', '-t', session, '-S', '-80'], {
    ignoreFailure: true,
  });
  parts.push(`--- tmux pane ---\n${pane.stdout || pane.stderr}`);
  return parts.join('\n\n');
}

async function waitFor(label: string, ready: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}\n\n${workerLog()}`);
}

/** The child projection under the parent step that owns it, read through the gateway method. */
async function childProjection(step = OWNING_STEP): Promise<TaskStepSubtaskProgress | undefined> {
  const progress = await taskProgress({
    slotId,
    taskFile: path.join(workerTaskRel, 'CHECKLIST.md'),
  });
  return (progress.structured?.phases ?? [])
    .flatMap((phase) => phase.steps)
    .find((candidate) => candidate.index === step)?.subtask;
}

async function waitForChildStatus(
  expected: string,
  step = OWNING_STEP,
): Promise<TaskStepSubtaskProgress> {
  let seen: TaskStepSubtaskProgress | undefined;
  let lastError: string | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      seen = await childProjection(step);
      if (seen?.status === expected) return seen;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for the child projection to read '${expected}' on step ${step}; ` +
      `last seen ${JSON.stringify(seen)}${lastError ? ` (last read error: ${lastError})` : ''}\n\n${workerLog()}`,
  );
}

function stepIsChecked(file: string, stepNumber: number): boolean {
  const rows = readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => /^- \[( |x)\]/.test(line.trim()));
  return Boolean(rows[stepNumber - 1]?.trim().startsWith('- [x]'));
}

/**
 * The worker side, run by the project-owned scripted command. It touches only
 * the task dir's `./mark` shim — never the engine path — and blocks on an ack
 * file after each phase so the gateway can observe it.
 */
function writeDriverScript(): void {
  writeFileSync(
    driverScript,
    `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const taskDir = process.argv[2];
const skillFixture = process.argv[3];
const mark = path.join(taskDir, 'mark');
const log = path.join(taskDir, 'artifacts', 'driver.log');

function note(line) {
  appendFileSync(log, \`\${new Date().toISOString()} \${line}\\n\`);
}

function mk(args, { expectFailure = false } = {}) {
  const result = spawnSync(mark, args, { cwd: taskDir, encoding: 'utf-8' });
  const output = \`\${result.stdout ?? ''}\${result.stderr ?? ''}\`;
  note(\`mark \${args.join(' ')} -> exit \${result.status}\\n\${output}\`);
  if (expectFailure) {
    assert.notEqual(result.status, 0, \`mark \${args.join(' ')} should have been refused\`);
  } else {
    assert.equal(result.status, 0, \`mark \${args.join(' ')} failed: \${output}\`);
  }
  return output;
}

async function waitForAck(phase) {
  writeFileSync(path.join(taskDir, 'artifacts', \`phase-\${phase}\`), phase);
  const ack = path.join(taskDir, 'artifacts', \`ack-\${phase}\`);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(ack)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(\`worker timed out waiting for the gateway ack '\${phase}'\`);
}

async function main() {
  mk(['start']);
  mk(['1']);
  mk(['sub', 'start', 'perps-review', '--step', '${OWNING_STEP}', '--from', skillFixture]);
  mk(['sub', 'perps-review', '1']);
  await waitForAck('running');

  mk(['sub', 'perps-review', 'blocked', '--reason', 'the review target diff is not fetchable']);
  await waitForAck('blocked');

  // Resuming the child flips both signals back to running.
  mk(['sub', 'perps-review', '2']);
  mk(['sub', 'perps-review', '3']);
  writeFileSync(path.join(taskDir, 'artifacts', 'review.md'), '# Review\\n\\nNo blocking findings.\\n');
  mk(['sub', 'perps-review', 'complete', '--mark-last', '--report', 'artifacts/review.md']);
  await waitForAck('complete');

  // A second child keeps step ${SECOND_STEP}; the parent terminal mark must refuse while it is open.
  mk([
    'sub',
    'start',
    'evidence-pack',
    '--step',
    '${SECOND_STEP}',
    '--from',
    'inline:- [ ] **1. collect the evidence paths**\\n',
  ]);
  writeFileSync(
    path.join(taskDir, 'artifacts', 'pr-description.md'),
    '# Sub-task observability E2E\\n\\nChild unit driven end to end.\\n',
  );
  writeFileSync(path.join(taskDir, 'artifacts', 'learnings.md'), '- Child units are files.\\n');
  const refusal = mk(['complete', '--mark-last'], { expectFailure: true });
  assert.match(refusal, /evidence-pack/, 'the parent refusal must name the open child');
  await waitForAck('open-child');

  mk(['sub', 'evidence-pack', 'complete', '--mark-last']);
  mk(['complete', '--mark-last']);
  writeFileSync(path.join(taskDir, 'artifacts', 'phase-done'), 'done');
  note('driver finished');
}

await main();
`,
    'utf-8',
  );
}

function writeTempProject(): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'project.json'),
    `${JSON.stringify(
      {
        name: projectName,
        paths: { runtime_dir: '.agent', artifact_dir: '.task' },
        scripted: {
          commands: {
            'drive-subtask': {
              // A project-owned command ref, as the scripted-runner contract
              // requires: the gateway never takes a command from the dispatch.
              command: `node ${JSON.stringify(driverScript)} ${JSON.stringify(workerTaskDir)} ${JSON.stringify(skillFixture)}`,
              timeout_ms: 240_000,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeDriverScript();
}

function writeTempPool(): void {
  mkdirSync(path.dirname(poolFile), { recursive: true });
  writeFileSync(
    poolFile,
    `${JSON.stringify(
      {
        machine: 'subtask-gw-e2e',
        project: projectName,
        platform: 'cli',
        host: 'localhost',
        ssh_user: process.env.USER || 'dev',
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        slots: [
          {
            id: slotId,
            enabled: true,
            repo: '.',
            session,
            resources: { 'dev-server': { port: 7877 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** The task directory as task init writes it: document, checklist, mark shim, handoff. */
function writeSourceTaskDir(): void {
  mkdirSync(path.join(sourceTaskDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(sourceTaskDir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(sourceTaskDir, 'TASK.md'),
    [
      '# Worker: dev',
      '',
      '- Task profile: dev',
      '**Runner:** scripted',
      '',
      'Drive a child checklist unit through the gateway (ADR-060 phase 2).',
      '',
      'Execution checklist: `CHECKLIST.md`.',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(sourceTaskDir, 'CHECKLIST.md'), PARENT_CHECKLIST);
  const markEngine = path.join(
    root,
    'packages',
    'agent-runtime',
    'scripts',
    'mark-checklist-step.cjs',
  );
  writeFileSync(
    path.join(sourceTaskDir, 'mark'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      `exec \${FARMSLOT_MARK_CMD:-node "${markEngine}"} "$DIR" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(sourceTaskDir, 'inputs', 'handoff.json'),
    `${JSON.stringify(
      {
        attemptId: stamp,
        surface: 'test',
        project: projectName,
        flow: 'dev',
        task: { title: 'Sub-task observability gateway E2E' },
        taskDocument: 'TASK.md',
        report: 'artifacts/pr-description.md',
        learnings: 'artifacts/learnings.md',
      },
      null,
      2,
    )}\n`,
  );
}

/** A Run shaped exactly as the gateway's mirror and metrics readers consume it. */
function runRecord(): Run {
  return {
    id: `run-${stamp}`,
    project: projectName,
    slotId,
    flowType: 'dev',
    taskFile: path.join(sourceTaskDir, 'TASK.md'),
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: 'scripted' },
  } as unknown as Run;
}

async function main(): Promise<void> {
  process.env.NODE_TEST_CONTEXT = '1';
  writeTempPool();
  writeTempProject();
  writeSourceTaskDir();
  run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
  run('tmux', ['new-session', '-d', '-s', session, '-c', root]);

  try {
    const dispatch = await dispatchExecute(
      {
        slotId,
        taskFile: path.join(sourceTaskDir, 'TASK.md'),
        mode: 'validation',
        runner: 'scripted',
        skipPrepare: true,
        force: true,
        scripted: { mode: 'command', commandRef: 'drive-subtask' },
      },
      () => {},
    );
    assert.equal(dispatch.dispatched, true);
    // The dispatch copied subtasks/ with the other task-dir directories through
    // the one shared list; the worker task dir is the one the runner was given.
    assert.match(dispatch.launchCommand ?? '', new RegExp(`--task-dir '${workerTaskRel}'`));
    console.log(`[e2e] dispatched scripted command run onto ${slotId}`);

    // ── 1. The child appears under its parent step while it runs ──
    await waitFor('the worker to reach the running phase', () => existsSync(phasePath('running')));
    const running = await waitForChildStatus('running');
    assert.equal(running.id, 'perps-review');
    assert.equal(running.source.kind, 'skill');
    assert.equal(running.source.ref, skillFixture);
    assert.equal(running.progress.totalSteps, 3, 'the skill fixture enumerates three child steps');
    assert.equal(running.progress.completedSteps, 1);
    assert.ok(running.lastEventAt, 'a marked child reports its last mark time');
    assert.equal(
      stepIsChecked(path.join(workerTaskDir, 'CHECKLIST.md'), OWNING_STEP),
      false,
      'the parent box stays open while the child runs',
    );
    console.log(
      `[e2e] running: ${running.id} ${running.progress.completedSteps}/${running.progress.totalSteps} last=${running.lastEventAt}`,
    );

    // The gateway's terminal check must refuse a completion signal written around
    // the mark engine while this child is open.
    const openChildVerdict = await validateTerminalSignalArtifacts(
      slotId,
      path.join(workerTaskDir, 'SIGNAL.json'),
      { status: 'complete', outcome: 'success', timestamp: new Date().toISOString() },
      path.join(workerTaskDir, 'CHECKLIST.md'),
    );
    assert.equal(openChildVerdict.ok, false);
    assert.equal(openChildVerdict.ok === false && openChildVerdict.kind, 'artifact');
    assert.match(
      openChildVerdict.ok === false ? openChildVerdict.message : '',
      /perps-review \(running\)/,
    );
    console.log('[e2e] terminal check refused a complete signal with an open child');
    writeFileSync(ackPath('running'), 'go');

    // ── 2. blocked, then resumed ──
    await waitFor('the worker to block the child', () => existsSync(phasePath('blocked')));
    const blocked = await waitForChildStatus('blocked');
    assert.equal(blocked.progress.completedSteps, 1);
    const parentSignal = JSON.parse(
      readFileSync(path.join(workerTaskDir, 'SIGNAL.json'), 'utf-8'),
    ) as { status: string; reason?: string };
    assert.equal(parentSignal.status, 'blocked', 'a blocked child blocks the parent signal');
    assert.match(parentSignal.reason ?? '', /^subtask perps-review: /);
    console.log(`[e2e] blocked: parent signal ${parentSignal.status} — ${parentSignal.reason}`);
    writeFileSync(ackPath('blocked'), 'go');

    // ── 3. complete ticks the parent box ──
    await waitFor('the worker to complete the child', () => existsSync(phasePath('complete')));
    const complete = await waitForChildStatus('complete');
    assert.equal(complete.progress.completedSteps, 3);
    assert.equal(complete.progress.totalSteps, 3);
    assert.equal(
      stepIsChecked(path.join(workerTaskDir, 'CHECKLIST.md'), OWNING_STEP),
      true,
      'child completion ticks the parent box',
    );
    console.log(
      `[e2e] complete: ${complete.progress.completedSteps}/${complete.progress.totalSteps}, parent step ${OWNING_STEP} ticked`,
    );
    writeFileSync(ackPath('complete'), 'go');

    // ── 4. a second open child is projected on its own step and refuses the parent ──
    await waitFor('the worker to register the second child', () =>
      existsSync(phasePath('open-child')),
    );
    const secondChild = await waitForChildStatus('running', SECOND_STEP);
    assert.equal(secondChild.id, 'evidence-pack');
    assert.equal(secondChild.source.kind, 'inline');
    // The first child stays projected as complete beside it.
    assert.equal((await childProjection(OWNING_STEP))?.status, 'complete');
    console.log(`[e2e] second child projected on step ${SECOND_STEP}: ${secondChild.id}`);
    writeFileSync(ackPath('open-child'), 'go');

    // ── 5. the run finishes; mirror and metrics read the real files ──
    await waitFor('the worker to finish', () => existsSync(phasePath('done')), 120_000);
    const record = runRecord();

    const metrics = await collectRunSubtaskMetrics(record, slotId);
    assert.ok(metrics, 'run metrics carry the child units');
    assert.deepEqual(
      metrics.map((entry) => entry.id).sort(),
      ['evidence-pack', 'perps-review'],
      'both registered children roll up',
    );
    const reviewMetrics = metrics.find((entry) => entry.id === 'perps-review');
    assert.equal(reviewMetrics?.status, 'complete');
    assert.equal(reviewMetrics?.completedSteps, 3);
    assert.equal(reviewMetrics?.totalSteps, 3);
    assert.deepEqual(reviewMetrics?.parent, { checklist: 'CHECKLIST.md', stepNumber: OWNING_STEP });
    assert.ok(
      reviewMetrics?.durationMs != null && reviewMetrics.durationMs >= 0,
      'a child that marked steps reports a duration',
    );
    assert.equal(reviewMetrics?.checklistTiming?.events.length, 3);
    console.log(
      `[e2e] metrics: ${metrics
        .map(
          (entry) =>
            `${entry.id} ${entry.status} ${entry.completedSteps}/${entry.totalSteps} ${entry.durationMs}ms`,
        )
        .join(' | ')}`,
    );

    await refreshArtifactMirror(record);
    const mirrorDir = path.join(sourceTaskDir, 'subtasks');
    for (const name of [
      'index.json.worker',
      'perps-review.md.worker',
      'perps-review-SIGNAL.json.worker',
      'evidence-pack.md.worker',
      'evidence-pack-SIGNAL.json.worker',
    ]) {
      assert.ok(existsSync(path.join(mirrorDir, name)), `mirror must write subtasks/${name}`);
    }
    const mirroredChild = readFileSync(path.join(mirrorDir, 'perps-review.md.worker'), 'utf-8');
    assert.equal(
      (mirroredChild.match(/^- \[x\]/gm) ?? []).length,
      3,
      'the mirrored child checklist carries the worker marks',
    );
    console.log('[e2e] mirror: subtasks/*.worker written beside the orchestrator copy');

    // ── 6. re-staging the mirrored task dir must not send the mirror back ──
    // The orchestrator copy now holds real `.worker` files, written from this slot
    // a moment ago, and nothing else: the mirror is the only thing that ever puts
    // a `subtasks/` entry on the orchestrator side. Staging it again is what a
    // re-dispatch, nudge, or warm handoff does — every one of those five files
    // would have landed on the worker before the filter.
    const mirrored = readdirSync(mirrorDir).sort();
    assert.equal(
      mirrored.filter((name) => name.endsWith('.worker')).length,
      5,
      `the orchestrator side must hold the mirror: ${mirrored.join(', ')}`,
    );
    // One prepared (non-mirror) child file, standing in for a task directory that
    // arrives with a child unit already materialized — proof the filter is
    // selective rather than skipping the directory wholesale.
    writeFileSync(path.join(mirrorDir, 'prepared.md'), '- [ ] **1. prepared child step**\n');

    const reStageDir = path.join(root, 'temp', `subtask-restage-${stamp}`);
    mkdirSync(reStageDir, { recursive: true });
    try {
      const staged = await copyTaskDirSubdirectories({
        taskDir: sourceTaskDir,
        workerTaskAbs: reStageDir,
        host: 'localhost',
        machine: 'local',
      });
      assert.ok(staged.includes('subtasks'), 'subtasks/ travels with the other task-dir copies');
      const reStaged = readdirSync(path.join(reStageDir, 'subtasks')).sort();
      assert.deepEqual(
        reStaged,
        ['prepared.md'],
        `only non-mirror files may travel; got ${reStaged.join(', ') || '(nothing)'}`,
      );
      console.log(
        `[e2e] re-stage: ${mirrored.length} mirror file(s) skipped, ${reStaged.length} prepared file(s) sent`,
      );
    } finally {
      rmSync(reStageDir, { recursive: true, force: true });
    }

    console.log(
      'e2e:subtask-gateway ok — projection, terminal check, mirror, metrics and one-way copy on a live dispatch',
    );
  } finally {
    // dispatchExecute armed the real task watcher on this slot — including the
    // child-unit watches the log above shows it opening. Release it before the
    // pool file and task dir go, or the teardown races a live read.
    await unwatchSlot(slotId).catch((err: unknown) => {
      console.warn(`[e2e] unwatch failed: ${(err as Error).message}`);
    });
    run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
    rmSync(poolFile, { force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(workerTaskDir, { recursive: true, force: true });
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
