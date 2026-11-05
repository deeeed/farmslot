#!/usr/bin/env tsx
// Live proof (F366) that reads of open publish gates stay inside the 250 ms interactive budget.
// An isolated gateway and node hold three dev runs at a ready human gate on node-owned slots,
// as production does. The node's `git` answers each command 300 ms late, standing in for a loaded
// node. Twenty decision.list and run.get reads each are measured by the gateway's own collector
// (the snapshot Doctor and /metrics read); the live source and package checks the reads used to
// await must leave the foreground and run as background work.
// macOS only: the node's zsh login supplies the fixture's PATH.
//
// Run: yarn tsx scripts/runner-validation/gateway/gate-read-cost.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  poll,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson,
} from '../lib/isolated-stack.mjs';
import {
  type DecisionListResult,
  type FleetStatusResult,
  type GatewayPerformanceGetResult,
  Methods,
  type ReadyGatePrPackage,
  type Run,
  type RunGetResult,
} from '../../../packages/protocol/src/index.js';
import {
  performanceBudgetVerdicts,
  slowestActions,
} from '../../../packages/protocol/src/performance/index.js';

if (process.platform !== 'darwin') throw new Error('This proof needs macOS (a zsh login)');
const READS = 20;
const GATES = 3;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/gate-read-cost/${Date.now()}`);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'gate-read-cost-')));
// Not a local host name, so the gateway reaches the slots through the registered node.
const machine = 'gate-read-cost-node';
const project = 'gate-read-cost';
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
const parts: IsolatedStackParts = {};
const cleanupErrors: unknown[] = [];
const reaper = startReaper();
reaper.path(fixture);
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  parts.connection?.close();
  await attempt(() => stopProcess(parts.node));
  await attempt(() => stopProcess(parts.gateway));
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  reaper.done();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated gate read cost fixture');
  const origin = path.join(fixture, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  const now = new Date().toISOString();
  const slots: Array<{ slotId: string; repo: string; runId: string; headSha: string }> = [];
  for (let i = 0; i < GATES; i++) {
    const slotId = `gate-read-cost-${i}`;
    const repo = path.join(fixture, `slot-${i}`);
    await mkdir(path.join(repo, '.task/gate/artifacts'), { recursive: true });
    git(repo, 'init', '-q', '--initial-branch=main');
    await writeFile(path.join(repo, 'README.md'), `Fixture slot ${i}\n`);
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-qm', 'fixture');
    git(repo, 'remote', 'add', 'origin', origin);
    if (i === 0) git(repo, 'push', '-q', '-u', 'origin', 'main');
    await writeFile(path.join(repo, '.task/gate/TASK.md'), '# Gate read fixture\n');
    await writeFile(path.join(repo, '.task/gate/artifacts/evidence-manifest.json'), '{}');
    slots.push({
      slotId,
      repo,
      runId: `gate-read-cost-run-${i}`,
      headSha: git(repo, 'rev-parse', 'HEAD'),
    });
  }
  // The node's `git`: every command waits 300 ms first. The node's commands take their PATH from
  // its zsh login, so a login profile puts the fixture first.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  await writeFile(
    path.join(shimDir, 'git'),
    `#!/bin/sh\nsleep 0.3\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  await chmod(path.join(shimDir, 'git'), 0o755);
  const zdotdir = path.join(fixture, 'zdotdir');
  await mkdir(zdotdir);
  await writeFile(
    path.join(zdotdir, '.zprofile'),
    `export PATH=${JSON.stringify(shimDir)}:"$PATH"\n`,
  );
  await writeJson(path.join(fixture, `projects/${project}/project.json`), {
    name: project,
    repo_url: origin,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
  });
  await writeJson(path.join(fixture, `pool/${project}.json`), {
    machine,
    host: `${machine}.invalid`,
    ssh_user: process.env.USER ?? 'operator',
    project,
    platform: 'cli',
    os: process.platform,
    slots: slots.map(({ slotId, repo }) => ({
      id: slotId,
      enabled: true,
      repo,
      session: slotId,
      resources: {},
    })),
  });
  await writeJson(path.join(fixture, '.farm-status.json'), {
    checked_at: now,
    slots: slots.map(({ slotId, repo, runId }) => ({
      slot: slotId,
      machine,
      project,
      platform: 'cli',
      repo,
      session: slotId,
      lifecycle: 'held',
      phase: 'human-gate',
      agent: 'idle',
      enabled: true,
      slot_epoch: 1,
      current_run_id: runId,
      health: { ssh: 'OK', device: '-', devserver: '-', fixtures: '-' },
    })),
  });
  for (const { slotId, repo, runId, headSha } of slots) {
    const diffStat = { files: 1, additions: 1, deletions: 0 };
    const pkg: ReadyGatePrPackage = {
      id: `${runId}-package`,
      artifactPath: 'artifacts/pr-package.json',
      packageHash: `${runId}-hash`,
      branch: 'main',
      remoteBranchRef: 'origin/main',
      headSha,
      diffStat,
      draftTitle: 'test: gate read fixture',
      draftBody: 'Fixture',
      evidenceManifest: [],
      selectedEvidenceKeys: [],
      validationSummaryPath: null,
      validationSummaryHash: null,
      reviewArtifactIds: [],
      dispatchMode: 'interactive',
      gatePolicy: {
        owner: 'human',
        dispatchMode: 'interactive',
        publishAuthority: 'human',
        reason: 'local-first publication requires human approval',
      },
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: now,
    };
    const run: Run = {
      id: runId,
      familyId: runId,
      parentRunId: null,
      familyRootTicketOrPr: runId,
      lane: 'production',
      variant: null,
      flowType: 'dev',
      mode: 'interactive',
      status: 'human-gating',
      project,
      ticketOrPr: runId,
      slotId,
      branch: 'main',
      taskFile: path.join(repo, '.task/gate/TASK.md'),
      steps: [],
      decisions: [
        {
          id: `${runId}-gate`,
          type: 'engine_human_gate',
          title: 'Fixture gate',
          description: '',
          createdAt: now,
          actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
          payload: {
            kind: 'ready',
            prNumber: null,
            repo: null,
            diffStat: pkg.diffStat,
            workerReport: '',
            branch: 'main',
            headSha,
            prPackage: pkg,
          },
        },
      ],
      metrics: {
        nudgeCount: 0,
        model: 'scripted',
        runner: 'scripted',
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(path.join(fixture, 'runs', `${runId}.json`), run);
  }
  const { connection: gw } = await startIsolatedStack(
    { root, evidence, env, fixture, reaper, node: { machine, env: { ZDOTDIR: zdotdir } } },
    parts,
  );
  await poll(
    'the fixture node to serve its slots',
    async () => {
      const { fleet } = await gw.call<FleetStatusResult>('fleet.status');
      const ready = slots.every(
        ({ slotId }) => fleet.slots.find((slot) => slot.slot === slotId)?.workspace,
      );
      if (!ready) await delay(500);
      return ready || undefined;
    },
    60_000,
  );
  const before = await gw.call<GatewayPerformanceGetResult>(Methods.GATEWAY_PERFORMANCE_GET);
  const listed: number[] = [];
  const shown: number[] = [];
  for (let i = 0; i < READS; i++) {
    const { decisions } = await gw.call<DecisionListResult>(Methods.DECISION_LIST);
    listed.push(
      decisions.filter((decision) => decision.id.startsWith('gate-read-cost-run-')).length,
    );
    const { run } = await gw.call<RunGetResult>(Methods.RUN_GET, { runId: slots[i % GATES].runId });
    shown.push(run.decisions.filter((decision) => !decision.resolvedAt).length);
  }
  const snapshot = await gw.call<GatewayPerformanceGetResult>(Methods.GATEWAY_PERFORMANCE_GET);
  const verdicts = performanceBudgetVerdicts(snapshot);
  const counted = (method: string, name: string, at: GatewayPerformanceGetResult) =>
    at.counters
      .filter((row) => row.labels.method === method && row.name === name)
      .reduce((sum, row) => sum + row.value, 0);
  const methods = slowestActions(snapshot)
    .filter(
      (row) =>
        row.side === 'gateway' &&
        row.phase === 'RPC' &&
        (row.method === Methods.DECISION_LIST || row.method === Methods.RUN_GET),
    )
    .map((row) => ({
      method: row.method,
      count: row.count,
      p50: row.p50,
      p95: row.p95,
      max: row.max,
      execCount: row.execCount,
      nodeCount: row.nodeCount,
      nodeSeconds: row.nodeSeconds,
      budget: verdicts.find(
        (verdict) =>
          verdict.metric === 'farmslot_rpc_duration_seconds' && verdict.method === row.method,
      )?.status,
    }));
  const background = {
    execCount:
      counted('_background', 'farmslot_exec_calls_total', snapshot) -
      counted('_background', 'farmslot_exec_calls_total', before),
    nodeCount:
      counted('_background', 'farmslot_node_calls_total', snapshot) -
      counted('_background', 'farmslot_node_calls_total', before),
  };
  result = {
    workload: { reads: READS, gates: GATES, gitDelaySeconds: 0.3, machine },
    methods,
    background,
    listed,
    shown,
  };
  await writeJson(path.join(evidence, 'gate-read-cost.json'), result);
  assert.deepEqual(listed, Array(READS).fill(GATES), 'every list shows each open gate');
  assert.deepEqual(shown, Array(READS).fill(1), 'every detail shows its open gate');
  for (const method of [Methods.DECISION_LIST, Methods.RUN_GET]) {
    const row = methods.find((entry) => entry.method === method);
    assert.ok(row, `${method} measured`);
    assert.equal(row.count, READS);
    assert.equal(row.execCount + row.nodeCount, 0, `${method} waits on no process or node`);
    assert.equal(row.budget, 'pass', `${method} p95 inside the interactive-read budget`);
  }
  assert.ok(background.nodeCount > 0, 'live gate checks still run, in the background');
} catch (error) {
  failure = error;
  await writeJson(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  await cleanup();
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
