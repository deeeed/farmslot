// Opt-in archive lookup proof. No reviewer or provider command is started.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  RunCreateParams,
  RunResolveDecisionParams,
  RunReviewResult,
} from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test(
  'archiving a reviewer preserves WARM RPC preflight and its refusal fences',
  { timeout: 120_000 },
  async (t) => {
    const output = process.env.FARMSLOT_ARCHIVED_WARM_OUT;
    assert(output, 'Set FARMSLOT_ARCHIVED_WARM_OUT');
    const source = fileURLToPath(new URL('../../../../', import.meta.url));
    const root = await mkdtemp(path.join(os.tmpdir(), 'archived-warm-rpc-'));
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      TMUX_TMPDIR: path.join(root, 'tmux'),
    });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    for (const name of ['home', 'pool', 'tmux', 'projects/review'])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [] }));
    await writeFile(
      path.join(root, 'projects/review/project.json'),
      JSON.stringify({ name: 'review' }),
    );
    await import('../runtime/mock-pty.test-support.js');
    const fixture = await createNativeProofFixture(t, root);
    const store = await import('../runs/store.js');
    const { runWithSessionOriginator } = await import('../security/work-originator.js');
    const create = (params: RunCreateParams) =>
      runWithSessionOriginator(fixture.person, () => store.createRun(params));
    const head = 'a'.repeat(40);
    const reviewId = 'archived-lineage';
    const prior = create({
      flowType: 'fix-bug',
      mode: 'autonomous',
      project: 'review',
      ticketOrPr: 'example/app#42',
      transport: 'tmux',
      slotId: 'unavailable-proof-slot',
    });
    const result: RunReviewResult = {
      recommendation: 'pass',
      reviewMd: 'Review complete.',
      lineComments: [],
      reviewSnapshot: { source: 'github-pr', headSha: head, capturedAt: new Date().toISOString() },
      session: {
        mode: 'cold',
        continuity: 'fresh',
        reviewId,
        sessionId: 'retained-session',
        repository: 'example/app',
        prNumber: 42,
        lastReviewedHeadSha: head,
      },
    };
    store.updateRun(prior.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      reviewResult: result,
      engineState: {
        publishGate: {
          reviews: [
            {
              id: reviewId,
              source: 'pipeline',
              runner: 'codex',
              model: 'gpt-6.1-sol',
              effort: 'high',
              mode: 'cold',
              loopNumber: 1,
              verdict: 'pass',
              unresolvedCount: 0,
              reviewerSessionId: 'retained-session',
              reviewedHeadSha: head,
              completedAt: new Date().toISOString(),
            },
          ],
        },
      },
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          runId: prior.id,
          slotId: prior.slotId!,
          status: 'complete',
          reviewId,
          runner: 'codex',
          model: 'gpt-6.1-sol',
          effort: 'high',
          runnerSessionId: 'retained-session',
          runnerSessionPath: '/fixture/session.jsonl',
          runnerSessionCapturedAt: new Date().toISOString(),
          reviewResultValidatedAt: new Date().toISOString(),
          target: { session: 'fixture', window: 'review', pane: '0', target: 'fixture:review.0' },
        },
      ],
    });
    const current = create({
      familyId: prior.familyId,
      flowType: 'fix-bug',
      mode: 'autonomous',
      project: 'review',
      ticketOrPr: 'example/app#42',
      transport: 'tmux',
      slotId: prior.slotId!,
    });
    store.updateRun(current.id, {
      status: 'human-gating',
      decisions: [
        {
          id: 'review-gate',
          type: 'engine_human_gate',
          title: 'Review',
          description: '',
          createdAt: new Date().toISOString(),
          actions: [{ id: 'request-review', label: 'Review', style: 'primary' }],
        },
      ],
    });
    const reviewRequest = {
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      mode: 'warm' as const,
      context: { reviewLineages: [{ repository: 'example/app', prNumber: 42, reviewId }] },
    };
    const request: RunResolveDecisionParams = {
      runId: current.id,
      decisionId: 'review-gate',
      actionId: 'request-review',
      selectionData: { reviewRequest },
    };
    // Missing execution capacity is deliberate: no reviewer can launch. Reaching this guard
    // proves the earlier WARM provenance check accepted the retained session.
    const nextGuard = { code: 'PUBLICATION_REVIEW_GIT_PROBE_FAILED' };
    await assert.rejects(fixture.client.call('run.resolveDecision', request), nextGuard);
    await store.archiveRun(prior.id);
    // A restarted gateway has no in-memory reviewer claim to mask a missing history read.
    const { resetWarmReviewerSessionsForTest } = await import('./session-mode.js');
    resetWarmReviewerSessionsForTest();
    const archive = path.join(root, 'runs/archive', `${prior.id}.json`);
    const before = await readFile(archive);
    assert.equal(store.getRun(prior.id), undefined);
    await assert.rejects(fixture.client.call('run.resolveDecision', request), nextGuard);
    for (const patch of [{ model: 'gpt-6-astra' }, { effort: 'low' }]) {
      await assert.rejects(
        fixture.client.call('run.resolveDecision', {
          ...request,
          selectionData: { reviewRequest: { ...reviewRequest, ...patch } },
        }),
        /WARM review refused/,
      );
    }
    assert.equal(store.getRun(current.id)?.decisions[0].resolvedAt, undefined);
    assert.equal(store.getRun(current.id)?.reviewRoundAdmissions?.length ?? 0, 0);
    assert.equal(store.getRun(prior.id), undefined);
    assert.deepEqual(await readFile(archive), before);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          pass: true,
          priorRunId: prior.id,
          liveAndArchivedWarmPreflightAgree: true,
          archivedLookupAfterRegistryReset: true,
          normalLaunchGuardReached: true,
          modelAndEffortRefused: true,
          gateUnconsumed: true,
          archiveUnchanged: true,
          priorNotRestored: true,
          modelCalls: 0,
          reviewerStarted: false,
          scope: 'Authenticated RPC archive lookup, not a live runner-resume proof.',
        },
        null,
        2,
      ) + '\n',
    );
  },
);
