#!/usr/bin/env tsx
// Live proof that a run created with `pipelineReview: 'none'` reaches REVIEW and skips it: no
// reviewer launches, the step records why, and the run goes on to COMPLETE. The engine runs for
// real on an isolated gateway and node (own pool, projects, runs, home and private tmux server).
// The worker is the scripted runner: its command commits one change on the slot branch and writes
// the dev reports, so REVIEW would otherwise review a code change. `codex` and `claude` on the
// node's PATH are fixtures that refuse, so even a regression launches no model.
//
// Run: yarn tsx scripts/runner-validation/gateway/no-pipeline-review-skip.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  poll,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import type { Run } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/no-pipeline-review-skip/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
// The node resolves the checkout's real path (macOS /var is /private/var); the pool names it.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'no-pipeline-review-skip-')));
// Every tmux call here, the gateway's and the node's, reaches only this proof's private server.
const tmuxDir = await mkdtemp('/tmp/nprs-');
const machine = 'pipeline-review-node';
const slotId = 'pipeline-review-slot';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');
// Created once MONITOR watches the worker; the worker's command waits for it.
const release = path.join(fixture, 'worker-release');
const baseEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
delete baseEnv.TMUX;
delete baseEnv.TMUX_PANE;
const reaper = startReaper();
reaper.path(fixture);
reaper.path(tmuxDir);
reaper.command(['tmux', 'kill-server'], baseEnv);
const parts: IsolatedStackParts = {};
let run: Run | undefined;
const cleanupErrors: unknown[] = [];
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  const { connection } = parts;
  if (connection && run && !['done', 'failed', 'cancelled'].includes(run.status)) {
    const { id } = run;
    await attempt(() =>
      connection.call('run.cancel', { runId: id, reason: 'pipeline review fixture cleanup' }),
    );
  }
  connection?.close();
  await attempt(() => stopProcess(parts.node));
  await attempt(() => stopProcess(parts.gateway));
  spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: baseEnv });
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  await attempt(() => rm(tmuxDir, { recursive: true, force: true }));
  reaper.done();
});
const tmux = (...args: string[]) =>
  execFileSync('tmux', args, { encoding: 'utf8', env: baseEnv }).trim();

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated pipeline review fixture');
  await linkCheckout(root, repo, 'Isolated pipeline review checkout');
  await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
  const project = path.join(fixture, 'projects/pipeline-review');
  await mkdir(path.join(project, 'templates/prompts'), { recursive: true });
  await writeFile(
    path.join(project, 'templates/prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}} and run the configured command.\n',
  );
  await mkdir(path.join(project, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(project, 'templates/worker/dev.md'),
    '# Worker: dev\n\n- [ ] Run the configured command.\n',
  );
  // The worker's whole turn: one committed change and the two reports a dev run hands over. It
  // holds until the proof sees MONITOR watching it (the launch check needs a live worker), and gives
  // up after 120 s if that never comes.
  const work = [
    `deadline=$(( $(date +%s) + 120 )); until [ -e '${release}' ]; do [ $(date +%s) -lt $deadline ] || exit 1; sleep 0.2; done`,
    'printf "proof\\n" > pipeline-review-proof.txt',
    'git add pipeline-review-proof.txt',
    'git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "test: pipeline review proof change"',
    'printf "# Pipeline review proof\\n\\nOne fixture change.\\n" > "$FARMSLOT_TASK_DIR/artifacts/pr-description.md"',
    'printf "# Learnings\\n\\n- Scripted proof worker.\\n" > "$FARMSLOT_TASK_DIR/artifacts/learnings.md"',
  ].join(' && ');
  await json(path.join(project, 'project.json'), {
    name: 'pipeline-review',
    repo_url: root,
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
    // Review is on for this project, so only the run's own policy can skip it.
    review: {
      enabled: true,
      runner: 'codex',
      model: 'gpt-6-luna',
      effort: 'low',
      mode: 'cold',
      max_retries: 0,
    },
    scripted: { commands: { change: { command: work, timeout_ms: 60_000 } } },
    monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
  });
  // A reviewer the engine might still launch finds these first and refuses: no model is reached.
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  for (const runner of ['codex', 'claude']) {
    await writeFile(
      path.join(shimDir, runner),
      `#!/bin/sh\necho "${runner} is disabled in this fixture" >&2\nexit 1\n`,
    );
    await chmod(path.join(shimDir, runner), 0o755);
  }
  await json(path.join(fixture, 'pool/pipeline-review.json'), {
    machine,
    host: 'localhost',
    ssh_user: process.env.USER ?? 'operator',
    project: 'pipeline-review',
    platform: 'cli',
    os: process.platform,
    env: { PATH: `${shimDir}:${process.env.PATH}` },
    slots: [{ id: slotId, enabled: true, repo, session, resources: {} }],
  });
  await json(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine,
        project: 'pipeline-review',
        platform: 'cli',
        repo,
        session,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        enabled: true,
        health: { ssh: 'LOCAL', device: '-', devserver: 'OK', fixtures: '-' },
      },
    ],
  });
  tmux('new-session', '-d', '-s', session, '-c', repo);
  const { connection: gw } = await startIsolatedStack(
    {
      root,
      evidence,
      env: baseEnv,
      fixture,
      reaper,
      node: { machine, env: { PATH: `${shimDir}:${process.env.PATH}` } },
    },
    parts,
  );

  run = (
    await gw.call<{ run: Run }>('run.create', {
      project: 'pipeline-review',
      flowType: 'dev',
      // Interactive dev with the reviewed profile: the profile that does run REVIEW (the lightweight
      // default skips it for its own reason), and the one that takes a free-text ticket.
      mode: 'interactive',
      devInteractiveProfile: 'reviewed',
      ticketOrPr: 'pipeline review skip proof',
      initialContext: 'Pipeline review skip validation run. Commits one fixture file.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: 'change' },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
      pipelineReview: 'none',
    })
  ).run;
  const runId = run.id;
  assert.equal(run.pipelineReview, 'none');
  await poll(
    'MONITOR to watch the worker',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      if (['failed', 'cancelled'].includes(run.status))
        throw new Error(`The run ended before MONITOR (${run.status}): ${run.error ?? ''}`);
      return run.steps.find((step) => step.name === 'monitor')?.status === 'running'
        ? run
        : undefined;
    },
    180_000,
  );
  await writeFile(release, '');
  // Past REVIEW: it either recorded its outcome, or a reviewer was started (the regression).
  const reviewed = await poll(
    'the run to pass REVIEW',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      const review = run.steps.find((step) => step.name === 'review');
      const reviewers = (run.agentContexts ?? []).filter((context) => context.role === 'review');
      // A reviewer context, a running REVIEW or a failed one (the launch was attempted) all mean
      // REVIEW did not skip.
      if (reviewers.length > 0 || review?.status === 'running' || review?.status === 'failed')
        return run;
      if (['failed', 'cancelled'].includes(run.status))
        throw new Error(`The run ended before REVIEW (${run.status}): ${run.error ?? ''}`);
      return review && !['pending', 'running'].includes(review.status) ? run : undefined;
    },
    240_000,
  );
  await json(path.join(evidence, 'run-after-review.json'), reviewed);
  const review = reviewed.steps.find((step) => step.name === 'review')!;
  const reviewers = (reviewed.agentContexts ?? []).filter((context) => context.role === 'review');
  assert.deepEqual(reviewers, [], 'no reviewer context was created');
  assert.equal(review.outputs?.reason, 'pipeline-review-off', `REVIEW: ${JSON.stringify(review)}`);
  assert.equal(review.outputs?.skipped, true);
  // The run goes on: COMPLETE runs (artifact-only then holds the output for its review card).
  const completed = await poll(
    'COMPLETE to run',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      const complete = run.steps.find((step) => step.name === 'complete');
      if (['failed', 'cancelled'].includes(run.status) || complete?.status === 'failed')
        throw new Error(
          `COMPLETE did not run (${run.status}): ${run.error ?? complete?.detail ?? ''}`,
        );
      return complete && ['running', 'done'].includes(complete.status) ? run : undefined;
    },
    120_000,
  );
  await json(path.join(evidence, 'run-final.json'), completed);
  result = {
    pass: true,
    evidence,
    runId,
    review: { status: review.status, outputs: review.outputs },
    reviewerContexts: reviewers.length,
    complete: completed.steps.find((step) => step.name === 'complete')?.status,
    runStatus: completed.status,
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
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
