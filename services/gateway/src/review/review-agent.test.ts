import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AgentContext } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-completion/test-fixtures.js';
import { retainedReviewerDeliveryPlan } from '../runners/registry.js';
import { recordRunnerSessionForRole } from '../runners/session-record.js';
import { makeVars } from '../runners/test-fixtures.js';
import { targetForChecklistBasename } from '../tasks/checklist-target.js';

import {
  liveNativeReviewer,
  prependReviewerExecutionContract,
  reReviewChecklistPrefix,
  resumeReviewAgentPromptDelivery,
  reviewChecklistMarkPrompt,
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  scopeReviewFeedbackPath,
  selectRecoverableReviewContext,
  waitForRecoveredReviewerOrCleanup,
} from './review-agent.js';
import { TerminalReviewArtifactError } from './terminal-result.js';

test('review recovery rejects in-place handoff for argv-first runners', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('./review-agent.ts', import.meta.url)),
    'utf8',
  );
  assert.match(source, /runnerRetainedSessionHandoff\(runner\) === 'argv-relaunch'/);
  assert.match(source, /abandonRecoveredReviewer\(`\$\{delivery\} recovered reviewer cleanup`\)/);
});

test('COLD creates a new conversation and unsupported WARM refuses', () => {
  for (const runner of ['claude', 'codex', 'cursor'])
    assert.deepEqual(retainedReviewerDeliveryPlan(runner, 'cold', 1), {
      kind: 'cold-relaunch',
      resetContext: false,
    });
  assert.deepEqual(retainedReviewerDeliveryPlan('codex', 'warm', 1), {
    kind: 'in-place',
    resetContext: false,
  });
  assert.throws(() => retainedReviewerDeliveryPlan('cursor', 'warm', 1), /WARM/);
});

test('restart recovery reclaims only the newest matching in-flight reviewer', () => {
  const context = (id: string, status: AgentContext['status'], scope: string | null) =>
    ({
      id,
      role: 'review',
      label: id,
      status,
      slotId: 'slot-1',
      runId: 'run-1',
      runner: 'claude',
      taskFile: `tasks/run-1/REVIEW.${id}.md`,
      signalFile: `tasks/run-1/REVIEW.${id}-SIGNAL.json`,
      artifactScope: scope,
      target: { session: 'ff-1', window: id, pane: null, target: `ff-1:${id}` },
    }) satisfies AgentContext;
  const contexts = [
    context('rev-claude', 'working', 'review-2'),
    context('rev1-claude', 'complete', 'review-2'),
    { ...context('rev2-claude', 'working', 'review-2'), reviewLoopNumber: 4 },
  ];

  const recovered = selectRecoverableReviewContext(contexts, {
    taskDir: 'tasks/run-1',
    runner: 'claude',
    artifactScope: 'review-2',
  });
  assert.equal(recovered?.id, 'rev2-claude');
  assert.equal(recovered?.reviewLoopNumber, 4);
  assert.equal(
    selectRecoverableReviewContext(contexts, {
      taskDir: 'tasks/run-1',
      runner: 'claude',
      artifactScope: null,
    }),
    null,
  );
});

test('a REVIEW re-entry finds the reviewer a restart left running, at its loop and lineage', () => {
  // TAT-4158 run 4237202e (generation 3, claude/opus, no artifact scope). The ids are the
  // recorded ones, so the prefix rule here is the one the native agent used.
  const taskDir = 'temp/tasks/feat/tat-4158-1019-203908';
  const pipeline = 'pipeline-review-4237202e-c2a6-4b60-aa84-1c87ad22da6a';
  const reviewer = (
    key: string,
    reviewLoopNumber: number,
    reviewId: string,
    status: AgentContext['status'],
  ) => {
    const id = `rev-claude-native-${key}`;
    return {
      id,
      role: 'review',
      label: id,
      status,
      slotId: 'macpro-mmt-2',
      runId: '4237202e-c2a6-4b60-aa84-1c87ad22da6a',
      runner: 'claude',
      taskFile: `${taskDir}/REVIEW.${id}.md`,
      signalFile: `${taskDir}/REVIEW.${id}-SIGNAL.json`,
      artifactScope: null,
      reviewLoopNumber,
      reviewId: reviewId === 'self' ? id : reviewId,
    } satisfies AgentContext;
  };
  const lineage2 = 'rev-claude-native-39adb3121840-d0e601c0';
  const run = (agentContexts: AgentContext[], generation = 3) => ({
    ...makeRun({ id: '4237202e-c2a6-4b60-aa84-1c87ad22da6a', engineState: { generation } }),
    agentContexts,
  });
  const params = { runner: 'claude', model: 'opus', taskDir, artifactScope: null };
  const firstPasses = [
    reviewer('ddbfd35f6488-f5ab7689', 1, pipeline, 'complete'),
    reviewer('39adb3121840-d0e601c0', 2, 'self', 'complete'),
  ];

  // Restart 3 (20:12Z): the loop-3 re-review was running.
  const third = liveNativeReviewer(
    run([...firstPasses, reviewer('9f987e055946-595fc400', 3, lineage2, 'working')]),
    params,
  );
  assert.equal(third?.id, 'rev-claude-native-9f987e055946-595fc400');
  assert.equal(third?.reviewLoopNumber, 3);
  assert.equal(third?.reviewId, lineage2);

  // Restart 5 (20:36Z): the loop-2 re-review of the recovered fix was running.
  const fifth = [
    ...firstPasses,
    reviewer('9f987e055946-595fc400', 3, lineage2, 'complete'),
    reviewer('ddbfd35f6488-b5263647', 1, pipeline, 'complete'),
    reviewer('39adb3121840-85add757', 2, 'self', 'working'),
  ];
  const live = liveNativeReviewer(run(fifth), params);
  assert.equal(live?.id, 'rev-claude-native-39adb3121840-85add757');
  assert.equal(live?.reviewLoopNumber, 2);
  assert.equal(live?.reviewId, live?.id);

  // Nothing running, another model or a replay's generation: a fresh first pass.
  assert.equal(liveNativeReviewer(run(fifth.slice(0, 4)), params), undefined);
  assert.equal(liveNativeReviewer(run(fifth), { ...params, model: 'sonnet' }), undefined);
  assert.equal(liveNativeReviewer(run(fifth, 4), params), undefined);
});

test('re-review prefix is cold on loop 1 and includes worker output from loop 2', () => {
  assert.equal(
    reReviewChecklistPrefix({
      taskDir: 'temp/tasks/foo',
      loopNumber: 1,
      currentHeadSha: 'abc',
    }),
    null,
  );
  const prefix = reReviewChecklistPrefix({
    taskDir: 'temp/tasks/foo',
    loopNumber: 2,
    artifactScope: 'review-3',
    priorHeadSha: 'aaa111',
    currentHeadSha: 'bbb222',
  });
  assert.match(prefix ?? '', /aaa111\.\.bbb222/);
  assert.match(prefix ?? '', /artifacts\/report\.md/);
  assert.match(prefix ?? '', /REVIEW-FIX\.md/);
  assert.match(prefix ?? '', /Review Fixes/);
  assert.match(prefix ?? '', /subset fixed \+ documented refusals/);
  assert.match(prefix ?? '', /Repeating the same/);
  assert.match(prefix ?? '', /review-3\/review-loop-1/);
  const resumed = reReviewChecklistPrefix({
    taskDir: 'temp/tasks/foo',
    loopNumber: 1,
    resume: true,
    priorArtifactScope: 'review-4',
    priorLoopNumber: 1,
    priorHeadSha: 'oldhead',
    currentHeadSha: 'newhead',
  });
  assert.match(resumed ?? '', /review-4\/review-loop-1/);
  assert.match(resumed ?? '', /do not re-state it as a new finding/i);
});

test('review agent instructions use context-scoped checklist, signal, and feedback files', () => {
  const checklist = reviewerChecklistBasename('rev-codex-2');
  const feedback = reviewerFeedbackRelPath('rev-codex-2');
  const target = targetForChecklistBasename(checklist);

  assert.equal(checklist, 'REVIEW.rev-codex-2.md');
  assert.equal(target.signal, 'REVIEW.rev-codex-2-SIGNAL.json');
  assert.equal(feedback, 'artifacts/review-feedback.rev-codex-2.md');

  const prompt = reviewChecklistMarkPrompt(
    'tasks/run-1',
    `tasks/run-1/${checklist}`,
    target,
    feedback,
  );

  assert.match(prompt, /--checklist REVIEW\.rev-codex-2\.md/);
  assert.match(prompt, /--signal REVIEW\.rev-codex-2-SIGNAL\.json/);
  assert.match(prompt, /tasks\/run-1\/artifacts\/review-feedback\.rev-codex-2\.md/);

  const checklistWithContract = prependReviewerExecutionContract('Review the diff.', prompt);
  assert.match(checklistWithContract, /^## Reviewer-specific execution contract/);
  assert.match(checklistWithContract, /--signal REVIEW\.rev-codex-2-SIGNAL\.json/);
  assert.match(checklistWithContract, /\n\nReview the diff\.$/);
});

test('review agent scopes legacy template feedback paths to the reviewer context', () => {
  const scoped = scopeReviewFeedbackPath(
    'Write tasks/run-1/artifacts/review-feedback.md, include review-feedback.md in evidence, but leave docs/review-feedback.md alone.',
    reviewerFeedbackRelPath('rev-claude'),
  );

  assert.equal(
    scoped,
    'Write tasks/run-1/artifacts/review-feedback.rev-claude.md, include artifacts/review-feedback.rev-claude.md in evidence, but leave docs/review-feedback.md alone.',
  );
});

test('review agent appends scoped feedback path when template omits legacy path', () => {
  const scoped = scopeReviewFeedbackPath('Review the diff.', reviewerFeedbackRelPath('rev-codex'));

  assert.equal(
    scoped,
    'Review the diff.\n\nWrite reviewer feedback to artifacts/review-feedback.rev-codex.md.',
  );
});

test('review agent does not rewrite a similarly named artifact directory', () => {
  const scoped = scopeReviewFeedbackPath(
    'Keep my-artifacts/review-feedback.md; write artifacts/review-feedback.md, now.',
    reviewerFeedbackRelPath('rev-codex'),
  );

  assert.equal(
    scoped,
    'Keep my-artifacts/review-feedback.md; write artifacts/review-feedback.rev-codex.md, now.',
  );
});

test('review prompt recovery retires an argv-first reviewer without tmux input', async () => {
  const vars = {
    projectName: 'farmslot-farm',
  } as Parameters<typeof resumeReviewAgentPromptDelivery>[0];
  let retiredWindow = '';
  const outcome = await resumeReviewAgentPromptDelivery(
    vars,
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: { session: 'mm-4', window: 'rev-cursor', pane: null, target: '@123' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      listExactTmuxWindows: async () => [
        {
          windowId: '@125',
          windowIndex: 1,
          windowName: 'rev-cursor',
          activityAt: 1,
          paneId: '%151',
          panePid: '59361',
        },
      ],
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      probeRunnerDescendantPid: async () => ({ state: 'present', pid: '59361' }),
      resolveTmuxWindowIdentity: async () => ({
        windowId: '@123',
        session: 'mm-4',
        window: 'rev-cursor',
      }),
      resolveTmuxWindowPaneCount: async () => 1,
      killTmuxWindowById: async (_vars, windowId) => {
        retiredWindow = windowId;
      },
      resolveWorkerDispatchPrompt: async () => {
        throw new Error('unsupported retained handoff must not build an in-place prompt');
      },
      resolveProjectRuntimeDir: async () => {
        throw new Error('unsupported retained handoff must not resolve runtime state');
      },
      sendRunnerPostLaunchPrompt: async () => {
        throw new Error('unsupported retained handoff must not send tmux input');
      },
    },
  );

  assert.equal(outcome, 'retired');
  assert.equal(retiredWindow, '@123');
});

test('review prompt recovery resolves and retires a pane-only reviewer window', async () => {
  let retiredWindow = '';
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: { session: '', window: null, pane: '%151', target: '%151' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      listExactTmuxWindows: async () => [
        {
          windowId: '@125',
          windowIndex: 1,
          windowName: 'rev-cursor',
          activityAt: 1,
          paneId: '%151',
          panePid: '59361',
        },
      ],
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      probeRunnerDescendantPid: async () => ({ state: 'present', pid: '59361' }),
      resolveTmuxWindowIdentity: async () => ({
        windowId: '@124',
        session: 'mm-4',
        window: 'rev-cursor',
      }),
      resolveTmuxWindowPaneCount: async () => 1,
      killTmuxWindowById: async (_vars, windowId) => {
        retiredWindow = windowId;
      },
    },
  );

  assert.equal(outcome, 'retired');
  assert.equal(retiredWindow, '@124');
});

test('review prompt recovery retires only the exact probed legacy reviewer window', async () => {
  let resolvedPane = '';
  let retiredWindow = '';
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: {
        session: 'mm-4',
        window: null,
        pane: null,
        target: 'mm-4:rev-cursor',
      },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      listExactTmuxWindows: async () => [
        {
          windowId: '@125',
          windowIndex: 1,
          windowName: 'rev-cursor',
          activityAt: 1,
          paneId: '%151',
          panePid: '59361',
        },
      ],
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      probeRunnerDescendantPid: async () => ({ state: 'present', pid: '59361' }),
      resolveTmuxWindowIdentity: async (_vars, paneId) => {
        resolvedPane = paneId;
        return { windowId: '@125', session: 'mm-4', window: 'rev-cursor' };
      },
      resolveTmuxWindowPaneCount: async () => 1,
      killTmuxWindowById: async (_vars, windowId) => {
        retiredWindow = windowId;
      },
    },
  );

  assert.equal(outcome, 'retired');
  assert.equal(resolvedPane, '%151');
  assert.equal(retiredWindow, '@125');
});

test('review prompt recovery preserves ambiguous named reviewer windows', async () => {
  let inspectedPane = false;
  const window = (windowId: string) => ({
    windowId,
    windowIndex: Number(windowId.slice(1)),
    windowName: 'rev-cursor',
    activityAt: 1,
    paneId: `%${windowId.slice(1)}`,
    panePid: '59361',
  });
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: {
        session: 'mm-4',
        window: null,
        pane: null,
        target: 'mm-4:rev-cursor',
      },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      listExactTmuxWindows: async () => [window('@1'), window('@2')],
      resolveExactTmuxWindowPane: async () => {
        inspectedPane = true;
        return { paneId: '%1', panePid: '59361' };
      },
    },
  );

  assert.equal(outcome, 'indeterminate');
  assert.equal(inspectedPane, false);
});

test('review prompt recovery preserves a split argv-first reviewer window', async () => {
  let retired = false;
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: { session: 'mm-4', window: 'rev-cursor', pane: null, target: '@123' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      probeRunnerDescendantPid: async () => ({ state: 'present', pid: '59361' }),
      resolveTmuxWindowIdentity: async () => ({
        windowId: '@123',
        session: 'mm-4',
        window: 'rev-cursor',
      }),
      resolveTmuxWindowPaneCount: async () => 2,
      killTmuxWindowById: async () => {
        retired = true;
      },
    },
  );

  assert.equal(outcome, 'indeterminate');
  assert.equal(retired, false);
});

test('review prompt recovery preserves a reused reviewer window id', async () => {
  let retired = false;
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: { session: 'mm-4', window: 'rev-cursor', pane: null, target: '@123' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      probeRunnerDescendantPid: async () => ({ state: 'present', pid: '59361' }),
      resolveTmuxWindowIdentity: async () => ({
        windowId: '@123',
        session: 'other-session',
        window: 'rev-cursor',
      }),
      killTmuxWindowById: async () => {
        retired = true;
      },
    },
  );

  assert.equal(outcome, 'indeterminate');
  assert.equal(retired, false);
});

test('review prompt recovery preserves an argv-first reviewer when liveness is unknown', async () => {
  let retired = false;
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-cursor',
      runner: 'cursor',
      taskFile: 'tasks/run-1/REVIEW.rev-cursor.md',
      signalFile: 'tasks/run-1/REVIEW.rev-cursor-SIGNAL.json',
      target: { session: 'mm-4', window: 'rev-cursor', pane: null, target: '@123' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      resolveExactTmuxWindowPane: async () => ({ paneId: '%151', panePid: '59361' }),
      probeRunnerDescendantPid: async () => ({
        state: 'unknown',
        code: 'probe-timeout',
        reason: 'probe timed out',
      }),
      killTmuxWindowById: async () => {
        retired = true;
      },
    },
  );

  assert.equal(outcome, 'indeterminate');
  assert.equal(retired, false);
});

test('review prompt recovery stays unsupported for non-interactive runners', async () => {
  const outcome = await resumeReviewAgentPromptDelivery(
    { projectName: 'farmslot-farm' } as Parameters<typeof resumeReviewAgentPromptDelivery>[0],
    'missing-run',
    {
      id: 'rev-scripted',
      runner: 'scripted',
      taskFile: 'tasks/run-1/REVIEW.rev-scripted.md',
      signalFile: 'tasks/run-1/REVIEW.rev-scripted-SIGNAL.json',
      target: { session: 'ff-1', window: 'rev-scripted', pane: null, target: 'ff-1:rev-scripted' },
      attemptStartedAt: '2026-08-24T03:37:05.626Z',
    },
    {
      resolveExactTmuxWindowPane: async () => {
        throw new Error('must not inspect tmux for unsupported runners');
      },
      probeRunnerDescendantPid: async () => {
        throw new Error('must not inspect tmux for unsupported runners');
      },
      resolveWorkerDispatchPrompt: async () => {
        throw new Error('must not build a prompt for unsupported runners');
      },
      resolveProjectRuntimeDir: async () => {
        throw new Error('must not resolve runtime for unsupported runners');
      },
      sendRunnerPostLaunchPrompt: async () => {
        throw new Error('must not send a prompt for unsupported runners');
      },
    },
  );

  assert.equal(outcome, 'unsupported');
});

function recoveryFixture() {
  const vars = makeVars({ slotId: 'slot-1' });
  const context: AgentContext = {
    id: 'rev-claude',
    runId: 'run-1',
    slotId: vars.slotId,
    role: 'review',
    label: 'Reviewer',
    status: 'working',
    runner: 'claude',
    taskFile: 'tasks/run-1/REVIEW.rev-claude.md',
    signalFile: 'tasks/run-1/REVIEW.rev-claude-SIGNAL.json',
    target: { session: 'ff-1', window: 'rev-claude', pane: null, target: 'ff-1:rev-claude' },
    attemptStartedAt: '2026-08-03T16:00:00.000Z',
    runnerSessionId: 'stale-session',
    runnerSessionPath: '/sessions/stale.jsonl',
  };
  const state = {
    run: {
      ...makeRun({ slotId: vars.slotId, status: 'monitoring', engineState: { generation: 1 } }),
      agentContexts: [context],
    },
    slot: { current_run_id: 'run-1', slot_epoch: 1 },
    sent: '',
    prompt: '',
    mirrors: 0,
    records: 0,
    kills: 0,
    beforeGuard: () => {},
    afterWrite: () => {},
  };
  const deps: NonNullable<Parameters<typeof resumeReviewAgentPromptDelivery>[3]> = {
    getRun: () => state.run,
    readSlotRow: async () => state.slot,
    listExactTmuxWindows: async () => [
      {
        windowId: '@22',
        windowIndex: 1,
        windowName: 'rev-claude',
        activityAt: 1,
        paneId: '%22',
        panePid: '2002',
      },
    ],
    resolveExactTmuxWindowPane: async () => ({ paneId: '%22', panePid: '2002' }),
    probeRunnerDescendantPid: async () => ({ state: 'present', pid: '2002' }),
    resolveWorkerDispatchPrompt: async () =>
      'Follow the checklist in tasks/run-1/REVIEW.rev-claude.md.',
    resolveProjectRuntimeDir: async () => 'temp/recipe/runtime',
    sendRunnerPostLaunchPrompt: async (_vars, pane, _runner, prompt) => {
      state.sent = pane;
      state.prompt = prompt;
    },
    captureRunnerSessionMetadata: async (_vars, _runner, _before, capture) => {
      assert.equal(state.sent, '%22');
      assert.equal(capture?.paneId, '%22');
      return { runnerSessionId: 'resumed-session', runnerSessionPath: '/sessions/resumed.jsonl' };
    },
    recordRunnerSessionForRole: (options) =>
      recordRunnerSessionForRole(options, {
        readRun: () => state.run,
        upsert: async (_runId, role, patch, write) => {
          state.beforeGuard();
          if (write?.guard && !(await write.guard())) return null;
          assert.equal(role, 'review');
          assert.equal(patch.id, context.id);
          const next = { ...state.run.agentContexts![0], ...patch };
          state.run = { ...state.run, agentContexts: [next] };
          state.records++;
          state.afterWrite();
          if (!write?.mirrorIf || write.mirrorIf(state.slot)) state.mirrors++;
          return next;
        },
      }),
    killTmuxWindowById: async () => {
      state.kills++;
    },
  };
  return {
    vars,
    context,
    state,
    deps,
    recover: () => resumeReviewAgentPromptDelivery(vars, 'run-1', context, deps),
  };
}

test('review prompt recovery replaces the binding without mutating its stale snapshot', async () => {
  const f = recoveryFixture();
  assert.equal(await f.recover(), 'delivered');
  assert.equal(f.context.runnerSessionId, 'stale-session');
  assert.equal(f.state.run.agentContexts![0].runnerSessionId, 'resumed-session');
  assert.equal(f.state.run.agentContexts![0].runnerSessionPath, '/sessions/resumed.jsonl');
  assert.equal(f.state.run.agentContexts![0].target?.paneId, '%22');
  assert.equal(f.state.mirrors, 1);
  assert.match(f.state.prompt, /REVIEW\.rev-claude\.md/);
  assert.doesNotMatch(f.state.prompt, /review-feedback\.rev-claude\.md/);
  assert.doesNotMatch(f.state.prompt, /SIGNAL\.json complete/);
});

test('review metadata failures defer and retry without killing accepted work', async () => {
  for (const phase of ['capture', 'record']) {
    const f = recoveryFixture();
    const capture = f.deps.captureRunnerSessionMetadata;
    const record = f.deps.recordRunnerSessionForRole;
    if (phase === 'capture')
      f.deps.captureRunnerSessionMetadata = async () => {
        throw new Error('metadata read timed out');
      };
    else
      f.deps.recordRunnerSessionForRole = async () => {
        throw new Error('metadata write failed');
      };
    assert.equal(await f.recover(), 'indeterminate');
    assert.equal(f.state.records, 0);
    assert.equal(f.state.kills, 0);
    f.deps.captureRunnerSessionMetadata = capture;
    f.deps.recordRunnerSessionForRole = record;
    assert.equal(await f.recover(), 'delivered');
    assert.equal(f.state.kills, 0);
  }
});

test('review capture cannot write after cancellation, reassignment or a queued attempt change', async () => {
  for (const phase of ['capture', 'write-queue']) {
    const f = recoveryFixture();
    const supersede = () => {
      f.state.run = { ...f.state.run, status: 'cancelled', engineState: { generation: 2 } };
      f.state.slot = { current_run_id: 'successor', slot_epoch: 2 };
    };
    if (phase === 'capture')
      f.deps.captureRunnerSessionMetadata = async () => {
        supersede();
        return { runnerSessionId: 'late-session', runnerSessionPath: '/late.jsonl' };
      };
    else f.state.beforeGuard = supersede;
    assert.equal(await f.recover(), 'indeterminate');
    assert.equal(f.state.records, 0);
    assert.equal(f.state.mirrors, 0);
    assert.equal(f.state.kills, 0);
  }
});

test('review capture rejects an in-place run generation update', async () => {
  const f = recoveryFixture();
  f.deps.captureRunnerSessionMetadata = async () => {
    Object.assign(f.state.run, { engineState: { generation: 2 } });
    return { runnerSessionId: 'late-session', runnerSessionPath: '/late.jsonl' };
  };
  assert.equal(await f.recover(), 'indeterminate');
  assert.equal(f.state.records, 0);
  assert.equal(f.state.mirrors, 0);
});

test('review capture rechecks cancellation after its queued asynchronous slot read', async () => {
  const f = recoveryFixture();
  let reads = 0;
  f.deps.readSlotRow = async () => {
    if (++reads === 2) {
      await Promise.resolve();
      Object.assign(f.state.run, { status: 'cancelled' });
    }
    return f.state.slot;
  };
  assert.equal(await f.recover(), 'indeterminate');
  assert.equal(f.state.records, 0);
  assert.equal(f.state.mirrors, 0);
});

test('a generation change between the run write and mirror cannot certify recovery', async () => {
  const f = recoveryFixture();
  f.state.afterWrite = () => {
    Object.assign(f.state.run, { engineState: { generation: 2 } });
  };
  assert.equal(await f.recover(), 'indeterminate');
  assert.equal(f.state.records, 1);
  assert.equal(f.state.mirrors, 0);
});

test('the slot mirror rechecks ownership after the run binding write', async () => {
  const f = recoveryFixture();
  f.state.afterWrite = () => {
    f.state.slot = { current_run_id: 'successor', slot_epoch: 2 };
  };
  await f.recover();
  assert.equal(f.state.records, 1);
  assert.equal(f.state.mirrors, 0);
});

test('an incomplete reviewer capture remains pending instead of certifying its stale binding', async () => {
  const f = recoveryFixture();
  f.deps.captureRunnerSessionMetadata = async () => ({
    runnerSessionId: null,
    runnerSessionPath: null,
  });
  assert.equal(await f.recover(), 'indeterminate');
  assert.equal(f.state.records, 0);
  assert.equal(f.state.kills, 0);
});

test('review recovery timeout performs cleanup before allowing a fresh reviewer', async () => {
  const cleanupReasons: Array<{ reason: string; status?: 'failed' | 'blocked' }> = [];
  const recordCleanup = async (reason: string, status?: 'failed' | 'blocked') => {
    cleanupReasons.push(status ? { reason, status } : { reason });
  };
  const completed = await waitForRecoveredReviewerOrCleanup(async () => false, recordCleanup);

  assert.equal(completed, false);
  assert.deepEqual(cleanupReasons, [{ reason: 'recovered reviewer timeout' }]);

  await assert.rejects(
    waitForRecoveredReviewerOrCleanup(async () => {
      throw new TerminalReviewArtifactError('invalid result');
    }, recordCleanup),
    TerminalReviewArtifactError,
  );
  assert.deepEqual(cleanupReasons.at(-1), {
    reason: 'invalid recovered reviewer artifact cleanup',
    status: 'blocked',
  });
});

test('continuing base review uses its unscoped artifacts', () => {
  const prefix = reReviewChecklistPrefix({
    taskDir: 'temp/tasks/task',
    loopNumber: 1,
    artifactScope: 'review-2',
    priorArtifactScope: null,
    priorLoopNumber: 1,
    priorHeadSha: 'prior',
    currentHeadSha: 'current',
    resume: true,
  });
  assert.ok(prefix);
  assert.match(prefix, /temp\/tasks\/task\/artifacts\/pipeline-review-loop-1/);
  assert.doesNotMatch(prefix, /artifacts\/review-2/);
});
