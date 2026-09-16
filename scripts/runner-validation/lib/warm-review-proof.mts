import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import type { Run, TaskProgressResult } from '../../../packages/protocol/src/index.js';

/** Two real gateway rounds with a scripted terminal reviewer, never a model invocation. */
export async function proveWarmReview(input: {
  connection: GatewayConnection;
  prior: Run;
  parameters: Record<string, unknown>;
  fixture: string;
  app: string;
  evidence: string;
}) {
  const { connection, prior, parameters, fixture, app, evidence } = input;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: app, encoding: 'utf8', stdio: 'pipe' }).trim();
  const oldHead = prior.reviewWorkspaceSubject!.headSha;
  await writeFile(path.join(app, 'message.txt'), 'hello again\n');
  git('add', 'message.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'test: revise reviewed fixture',
  );
  const newHead = git('rev-parse', 'HEAD');
  await writeFile(path.join(fixture, 'fixture-pr-head'), newHead);
  let run = (
    await connection.call<{ run: Run }>('run.create', {
      ...parameters,
      ticketOrPr: 'example/app#42',
      reviewScope: 'incremental',
      reviewAutoFinish: false,
    })
  ).run;
  const read = async () => (await connection.call<{ run: Run }>('run.get', { runId: run.id })).run;
  let completeSent = false;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      run = await read();
      if (run.status === 'failed') throw new Error(run.error);
      const decision = run.decisions.find(
        (d) => d.type === 'engine_review_posting' && !d.resolvedAt,
      );
      if (decision) break;
      if (run.status === 'blocked') throw new Error(run.error ?? 'Warm review blocked');
      if (run.status === 'monitoring' && !completeSent) {
        const params = { slotId: '', runId: run.id };
        const progress = await connection.call<TaskProgressResult>('task.progress', params);
        if (
          progress.structured?.phases.some((phase) =>
            phase.steps.some((step) => step.status === 'running'),
          )
        ) {
          await connection.call('terminal.subscribe', {
            ...params,
            interactive: true,
            cols: 100,
            rows: 30,
          });
          await connection.call('terminal.input', { ...params, data: 'complete-fixture\r' });
          await connection.call('terminal.unsubscribe', params);
          completeSent = true;
        }
      }
      await delay(250);
    }
    const gate = run.decisions.find((d) => d.type === 'engine_review_posting' && !d.resolvedAt);
    assert(gate, 'New head must stop at its own publication gate');
    assert.equal(run.reviewWorkspaceSubject?.headSha, newHead);
    assert.equal(run.repeatReviewContext?.priorReviewedHeadSha, oldHead);
    assert.equal(run.repeatReviewContext?.session?.continuity, 'resumed');
    assert.equal(
      run.agentContexts?.find((c) => c.id === 'review')?.runnerSessionId,
      prior.agentContexts?.find((c) => c.id === 'review')?.runnerSessionId,
    );
    assert.equal(run.reviewScope, 'incremental');
    assert.notEqual(run.reviewWorkspace?.checkoutPath, prior.reviewWorkspace?.checkoutPath);
    const task = path.dirname(run.taskFile!);
    const proof = JSON.parse(
      await readFile(path.join(task, 'artifacts/session-proof.json'), 'utf8'),
    );
    assert.equal(proof.history.head, oldHead);
    assert.equal(proof.history.finding, 'Fixture inline finding');
    assert((await readFile(path.join(task, 'TASK.md'), 'utf8')).includes(`${oldHead}..${newHead}`));
    assert.equal(
      (await connection.call<{ run: Run }>('run.get', { runId: prior.id })).run.reviewResult
        ?.reviewSnapshot?.headSha,
      oldHead,
    );
    await writeFile(
      path.join(evidence, 'warm-review.json'),
      JSON.stringify({ oldHead, newHead, run, proof }),
    );
    await connection.call('run.resolveDecision', {
      runId: run.id,
      decisionId: gate.id,
      actionId: 'dismiss',
    });
    for (let i = 0; i < 80; i++) {
      run = await read();
      if (run.status === 'done') break;
      await delay(100);
    }
    assert.equal(run.status, 'done');
  } finally {
    run = await read();
    if (!['done', 'failed', 'cancelled'].includes(run.status))
      await connection.call('run.cancel', { runId: run.id });
  }
}
