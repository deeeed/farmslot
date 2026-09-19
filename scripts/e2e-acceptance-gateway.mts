#!/usr/bin/env tsx
/**
 * E2E for the gateway side of the acceptance ledger (ADR-060 phase 5).
 *
 * A REAL dispatch (`dispatchExecute`) puts a REAL task directory on a local pool
 * slot, a project-owned `scripted` command records verdicts through the REAL
 * `farmslot-agent ac` entry point, and the gateway's own methods are called
 * in-process against the live files while the worker runs:
 *
 *   - `taskProgress` must carry `acceptanceStatus` as each verdict lands, and the
 *     ledger must never change the parent step projection;
 *   - `validateTerminalSignalArtifacts` must refuse a terminal signal while a
 *     criterion has no verdict, and again while one is `weak`, then accept once
 *     every criterion is proven or recorded untestable — proving a signal written
 *     around the mark engine cannot skip the ledger.
 *
 * Worker and gateway hand off through ack files so each phase is observed
 * deterministically instead of by sleeping.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AcceptanceStatusLedger } from '@farmslot/protocol';

import { dispatchExecute } from '../services/gateway/src/methods/dispatch/execute.js';
import { taskProgress } from '../services/gateway/src/methods/task.js';
import { unwatchSlot } from '../services/gateway/src/tasks/watcher.js';
import { validateTerminalSignalArtifacts } from '../services/gateway/src/tasks/worker-terminal-contract.js';

const root = process.cwd();
const stamp = `${process.pid}-${Date.now()}`;
const slotId = `acceptance-gw-${stamp}`;
const projectName = `acceptance-gw-${stamp}`;
const session = slotId;
const poolFile = path.join(root, 'pool', `${slotId}.json`);
const projectDir = path.join(root, 'projects', projectName);
const taskName = `acceptance-gateway-${stamp}`;
/** The orchestrator task root the gateway derives for a project (projects/<name>/tasks). */
const sourceTaskDir = path.join(projectDir, 'tasks', 'dev', taskName);
const workerTaskRel = path.join('.task', 'dev', taskName);
const workerTaskDir = path.join(root, workerTaskRel);
const driverScript = path.join(projectDir, 'drive-acceptance.mjs');
const agentBin = path.join(root, 'packages', 'agent-runtime', 'bin', 'farmslot-agent.mjs');
const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;

const CRITERIA = [
  'The run detail panel lists every criterion with its verdict.',
  'A weak verdict blocks the terminal signal.',
  'The biometric fallback matches platform guidance.',
];

const CHECKLIST = [
  '# Worker: dev',
  '',
  '## Work',
  '',
  '- [ ] **1. record the verdicts**',
  '- [ ] **2. write the terminal signal**',
  '',
].join('\n');

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

/** The ledger as the gateway projects it onto the progress result. */
async function ledgerFromGateway(): Promise<AcceptanceStatusLedger | undefined> {
  const progress = await taskProgress({
    slotId,
    taskFile: path.join(workerTaskRel, 'CHECKLIST.md'),
  });
  // The ledger is task-directory state: it must never move a step.
  assert.equal(progress.structured?.totalSteps, 2, 'the parent checklist still enumerates 2 steps');
  return progress.acceptanceStatus;
}

async function waitForVerdicts(expected: Array<string | null>): Promise<AcceptanceStatusLedger> {
  let seen: AcceptanceStatusLedger | undefined;
  const deadline = Date.now() + 90_000;
  const want = JSON.stringify(expected);
  while (Date.now() < deadline) {
    seen = await ledgerFromGateway();
    const verdicts = CRITERIA.map(
      (_text, index) =>
        seen?.criteria.find((entry) => entry.id === `AC-${index + 1}`)?.verdict ?? null,
    );
    if (JSON.stringify(verdicts) === want) return seen as AcceptanceStatusLedger;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for verdicts ${want}; last read ${JSON.stringify(seen)}\n\n${workerLog()}`,
  );
}

/** A terminal `complete` signal as a runner writing around `mark` would leave it. */
async function terminalVerdict() {
  return validateTerminalSignalArtifacts(
    slotId,
    path.join(workerTaskDir, 'SIGNAL.json'),
    { status: 'complete', outcome: 'success', timestamp: new Date().toISOString() },
    path.join(workerTaskDir, 'CHECKLIST.md'),
  );
}

/**
 * The worker side, run by the project-owned scripted command. It records verdicts
 * only through `farmslot-agent ac` — never by writing the ledger — and blocks on
 * an ack file after each phase so the gateway can observe it.
 */
function writeDriverScript(): void {
  writeFileSync(
    driverScript,
    `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const taskDir = process.argv[2];
const agentBin = process.argv[3];
const log = path.join(taskDir, 'artifacts', 'driver.log');

function note(line) {
  appendFileSync(log, \`\${new Date().toISOString()} \${line}\\n\`);
}

function ac(args) {
  const result = spawnSync(process.execPath, [agentBin, 'ac', args[0], '--task-dir', taskDir, ...args.slice(1)], {
    cwd: taskDir,
    encoding: 'utf-8',
  });
  const output = \`\${result.stdout ?? ''}\${result.stderr ?? ''}\`;
  note(\`ac \${args.join(' ')} -> exit \${result.status}\\n\${output}\`);
  assert.equal(result.status, 0, \`ac \${args.join(' ')} failed: \${output}\`);
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
  writeFileSync(path.join(taskDir, 'artifacts', 'after-unlock.png'), 'png-bytes');
  // One verdict at a time, each observed by the gateway before the next.
  ac(['set', 'AC-1', 'proven', '--proof-mode', 'visual', '--evidence', 'artifacts/after-unlock.png', '--recipe-node', 'assert-single-prompt']);
  await waitForAck('first');

  ac(['set', 'AC-2', 'weak', '--note', 'Unit test only; the cancel path is not wired yet.']);
  await waitForAck('weak');

  ac(['set', 'AC-2', 'proven', '--proof-mode', 'state', '--recipe-node', 'assert-vault-locked']);
  ac(['set', 'AC-3', 'untestable', '--note', 'No simulator path reaches the biometric prompt.']);
  const listed = JSON.parse(ac(['list']));
  assert.deepEqual(
    listed.map((row) => row.verdict),
    ['proven', 'proven', 'untestable'],
    'ac list must report what ac set wrote',
  );
  const rendered = ac(['render']);
  assert.match(rendered, /Overall recipe coverage: 2\\/3 ACs PROVEN \\(untestable: AC-3, weak: 0, missing: 0\\)/);
  writeFileSync(path.join(taskDir, 'artifacts', 'coverage.md'), rendered);
  writeFileSync(path.join(taskDir, 'artifacts', 'pr-description.md'), '# Acceptance ledger E2E\\n\\nVerdicts recorded.\\n');
  writeFileSync(path.join(taskDir, 'artifacts', 'learnings.md'), '- The ledger is the proof record.\\n');
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
            'drive-acceptance': {
              // A project-owned command ref, as the scripted-runner contract
              // requires: the gateway never takes a command from the dispatch.
              command: `node ${JSON.stringify(driverScript)} ${JSON.stringify(workerTaskDir)} ${JSON.stringify(agentBin)}`,
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
        machine: 'acceptance-gw-e2e',
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
            resources: { 'dev-server': { port: 7879 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * The task directory as task init writes it, with acceptance criteria in the
 * handoff — the ids the ledger uses come from that array and nowhere else.
 */
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
      'Record a verdict for every acceptance criterion (ADR-060 phase 5).',
      '',
      '## Acceptance Criteria',
      '',
      ...CRITERIA.map((criterion) => `- ${criterion}`),
      '',
      'Execution checklist: `CHECKLIST.md`.',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(sourceTaskDir, 'CHECKLIST.md'), CHECKLIST);
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
        schemaVersion: 1,
        attemptId: stamp,
        surface: 'test',
        project: projectName,
        domain: '',
        flow: 'dev',
        task: { title: 'Acceptance ledger gateway E2E', acceptanceCriteria: CRITERIA },
        taskDocument: 'TASK.md',
        report: 'artifacts/pr-description.md',
        learnings: 'artifacts/learnings.md',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(sourceTaskDir, 'inputs', 'worker-terminal-contract.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        flowType: 'dev',
        requireSignal: true,
        commands: {
          complete: {
            report: 'artifacts/pr-description.md',
            artifacts: ['artifacts/learnings.md', 'artifacts/pr-description.md'],
          },
          'no-change': { artifacts: [] },
          blocked: { artifacts: [] },
        },
        whenPresent: [],
        resolvedAt: new Date().toISOString(),
        source: 'builtin',
      },
      null,
      2,
    )}\n`,
  );
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
        scripted: { mode: 'command', commandRef: 'drive-acceptance' },
      },
      () => {},
    );
    assert.equal(dispatch.dispatched, true);
    console.log(`[e2e] dispatched scripted command run onto ${slotId}`);

    // ── 1. The first verdict reaches the gateway; the others are still unrecorded ──
    await waitFor('the worker to record the first verdict', () => existsSync(phasePath('first')));
    const first = await waitForVerdicts(['proven', null, null]);
    assert.equal(first.criteria.length, 1, 'only the recorded criterion is in the ledger');
    assert.equal(first.criteria[0].text, CRITERIA[0], 'the text comes from the handoff array');
    assert.deepEqual(first.criteria[0].evidence, ['artifacts/after-unlock.png']);
    assert.deepEqual(first.criteria[0].recipeNodes, ['assert-single-prompt']);
    assert.equal(first.criteria[0].proofMode, 'visual');
    console.log('[e2e] partial: AC-1 proven with evidence, AC-2 and AC-3 unrecorded');

    // A terminal signal written around `mark` must not pass with criteria open.
    const openVerdict = await terminalVerdict();
    assert.equal(openVerdict.ok, false);
    assert.equal(openVerdict.ok === false && openVerdict.kind, 'artifact');
    assert.match(openVerdict.ok === false ? openVerdict.message : '', /AC-2 has no verdict/);
    assert.match(openVerdict.ok === false ? openVerdict.message : '', /AC-3 has no verdict/);
    console.log('[e2e] terminal check refused a complete signal with unrecorded criteria');
    writeFileSync(ackPath('first'), 'go');

    // ── 2. A weak verdict is recorded and still refused ──
    await waitFor('the worker to record the weak verdict', () => existsSync(phasePath('weak')));
    const weak = await waitForVerdicts(['proven', 'weak', null]);
    assert.equal(weak.criteria[1].note, 'Unit test only; the cancel path is not wired yet.');
    const weakVerdict = await terminalVerdict();
    assert.equal(weakVerdict.ok, false);
    assert.match(weakVerdict.ok === false ? weakVerdict.message : '', /AC-2 is weak/);
    console.log('[e2e] terminal check refused a complete signal with a weak verdict');
    writeFileSync(ackPath('weak'), 'go');

    // ── 3. Every criterion settled: the same signal is accepted ──
    await waitFor('the worker to finish', () => existsSync(phasePath('done')), 120_000);
    const settled = await waitForVerdicts(['proven', 'proven', 'untestable']);
    assert.equal(settled.criteria.length, 3);
    assert.equal(
      settled.criteria[1].note,
      undefined,
      'the weak note does not survive the new verdict',
    );
    assert.equal(settled.criteria[2].note, 'No simulator path reaches the biometric prompt.');
    const settledVerdict = await terminalVerdict();
    assert.equal(
      settledVerdict.ok,
      true,
      `the terminal check must pass once every criterion is settled: ${
        settledVerdict.ok === false ? settledVerdict.message : ''
      }`,
    );
    console.log('[e2e] terminal check accepted the signal with 2/3 proven and 1 untestable');

    // The rendered coverage table the worker wrote from the ledger.
    const coverage = readFileSync(path.join(workerTaskDir, 'artifacts', 'coverage.md'), 'utf-8');
    assert.match(
      coverage.trimEnd().split('\n').pop() ?? '',
      /^Overall recipe coverage: 2\/3 ACs PROVEN \(untestable: AC-3, weak: 0, missing: 0\)$/,
    );
    console.log('e2e:acceptance-gateway ok — 3 criteria observed through the gateway');
  } finally {
    await unwatchSlot(slotId);
    run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
    rmSync(poolFile, { force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(workerTaskDir, { recursive: true, force: true });
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  }
}

await main();
