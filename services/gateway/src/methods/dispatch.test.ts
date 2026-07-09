import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComparisonVariant,
  DEFAULT_CURSOR_MODEL,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { runnerLaunchBlockerAutoActionKey } from '../runners/registry.js';

import {
  buildRoleLaunchCommandWithDiagnosticHold,
  cleanupLaunchedWorkerAfterDispatchFailure,
  resolveRunnerLaunchBlockers,
} from './dispatch/execute.js';
import {
  buildDispatchRoleShellCommand,
  canonicalAgentContextTarget,
  parseCapturedAgentPaneTarget,
} from './dispatch/role-target.js';
import { resolveDispatchSafetyTier } from './dispatch/safety-tier.js';
import {
  branchContainsJiraKey,
  evaluateSlotIdentityPolicy,
  isDispatchStaleBranch,
  isFreeSlot,
  resolveJiraTargetBranchFromFleet,
  slotScore,
  validateSlot,
} from './dispatch/slot-scoring.js';
import { flowTypeToKey } from './dispatch/task-flow-key.js';
import { assertTicketRefMatchesProjectRepo, normalizeTicketRef } from './dispatch/ticket-ref.js';
import {
  classifyRefreshSlotAction,
  findAffinitySlot,
  PoolConfigError,
  resolveDispatchFamilyContext,
  resolveDispatchPreviewFromFleet,
  resolveDispatchTargetBranch,
  resolvePreviewModel,
  selectBranchAffinityEligibleSlots,
  selectBranchAffinityRefreshSlots,
} from './dispatch.js';

function makeSlot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: overrides.slot ?? 'demo-1',
    machine: overrides.machine ?? 'demo',
    platform: overrides.platform ?? 'cli',
    project: overrides.project ?? 'farmslot-farm',
    health: overrides.health ?? {
      ssh: 'LOCAL',
      device: '-',
      devserver: 'OK',
      cdp: '-',
      fixtures: '-',
    },
    branch: overrides.branch ?? 'review/meta-mask-mobile-42-claude',
    agent: overrides.agent ?? 'idle',
    enabled: overrides.enabled ?? true,
    dispatchable: overrides.dispatchable ?? true,
    lifecycle: overrides.lifecycle ?? 'held',
    phase: overrides.phase ?? 'ci-watch',
    warm: overrides.warm ?? false,
    taskId: overrides.taskId ?? null,
    taskFile: overrides.taskFile ?? null,
    currentRunId: overrides.currentRunId ?? null,
    currentFlowType: overrides.currentFlowType ?? null,
    currentTicketOrPr: overrides.currentTicketOrPr ?? null,
    currentMode: overrides.currentMode ?? null,
    currentFamilyId: overrides.currentFamilyId ?? null,
    currentLane: overrides.currentLane ?? null,
    currentVariant: overrides.currentVariant ?? null,
    dispatchedAt: overrides.dispatchedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    runner: overrides.runner ?? null,
    model: overrides.model ?? null,
    resources: overrides.resources,
    deviceName: overrides.deviceName ?? null,
    taskPhase: overrides.taskPhase ?? null,
    taskStepProgress: overrides.taskStepProgress ?? null,
    prHealth: overrides.prHealth,
    hostLoad: overrides.hostLoad,
    session: overrides.session,
    repo: overrides.repo,
    linkedWorktree: overrides.linkedWorktree,
  };
}

test('parseCapturedAgentPaneTarget prefers tmux window name over numeric index', () => {
  assert.deepEqual(parseCapturedAgentPaneTarget('mme-4', 'mme-4:1.0|review'), {
    session: 'mme-4',
    window: 'review',
    pane: '0',
    target: 'mme-4:review',
  });
});

test('dispatch role shell command starts a real repo shell, not the prepare placeholder', () => {
  const command = buildDispatchRoleShellCommand('/tmp/farm slot/repo');

  assert.equal(command, "cd '/tmp/farm slot/repo' && exec ${SHELL:-bash}");
  assert.doesNotMatch(command, /while :; do sleep 86400; done/);
});

test('dispatch role launch wrapper holds failed runner output for diagnostics', () => {
  const command = buildRoleLaunchCommandWithDiagnosticHold('codex --model gpt-5.5');

  assert.match(command, /bash -lc/);
  assert.match(command, /runner launch command exited/);
  assert.match(command, /sleep 45/);
  assert.doesNotMatch(command, /^exec bash -lc/);
});

test('dispatch maps runner launch blocker auto-actions to submit keys', () => {
  assert.equal(runnerLaunchBlockerAutoActionKey('cursor-trust-workspace'), 'a');
  assert.equal(runnerLaunchBlockerAutoActionKey('grok-select-current-project'), 'Enter');
  assert.equal(runnerLaunchBlockerAutoActionKey(null), null);
});

const cursorWorkspaceTrustPane = `
  │  ▶ [a] Trust this workspace                                              │
  │    [q] Quit                                                              │
  │                                                                          │
  │  Use arrow keys to navigate, Enter to select, or press the key shown     │
`;

const grokMcpInitPane = `
    mcp (14/15)
    ⠋ Starting session... 5.0s

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                        │
  ╰───────────────────────────────────────────────────────────── Grok Build ─╯
`;

function makeSlotVars(overrides: Partial<SlotVars> = {}): SlotVars {
  return {
    slotId: 'macwork-mme-2',
    machine: 'macwork',
    platform: 'macos',
    host: 'localhost',
    sshUser: '',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'mme-2',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo: '/repo',
    projectName: 'metamask-extension-farm',
    resourceVars: {},
    ...overrides,
  };
}

test('resolveRunnerLaunchBlockers sends an auto-action once and waits for the blocker to clear', async () => {
  const commands: string[] = [];
  const panes = [cursorWorkspaceTrustPane, 'Cursor chat ready'];
  let now = 0;

  await resolveRunnerLaunchBlockers(makeSlotVars(), 'mme-2:dev', 'cursor', 5_000, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    exec: async (_vars, command) => {
      commands.push(command);
      if (command.includes('send-keys')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: panes.shift() ?? 'Cursor chat ready', stderr: '' };
    },
  });

  assert.equal(commands.filter((command) => command.includes('send-keys')).length, 1);
  assert.match(commands.find((command) => command.includes('send-keys')) ?? '', /send-keys .* 'a'/);
});

test('resolveRunnerLaunchBlockers waits for deferred blockers without sending input', async () => {
  const commands: string[] = [];
  const panes = [grokMcpInitPane, 'Grok ready'];
  let now = 0;

  await resolveRunnerLaunchBlockers(makeSlotVars(), 'ff-3:dev', 'grok', 5_000, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    exec: async (_vars, command) => {
      commands.push(command);
      return { exitCode: 0, stdout: panes.shift() ?? 'Grok ready', stderr: '' };
    },
  });

  assert.equal(
    commands.some((command) => command.includes('send-keys')),
    false,
  );
  assert.equal(commands.filter((command) => command.includes('capture-pane')).length, 2);
});

test('resolveRunnerLaunchBlockers fails unsafe blockers immediately', async () => {
  await assert.rejects(
    resolveRunnerLaunchBlockers(makeSlotVars(), 'mme-2:dev', 'cursor', 5_000, {
      exec: async () => ({
        exitCode: 0,
        stdout: 'Authentication expired. Please run cursor-agent login to continue.',
        stderr: '',
      }),
    }),
    /Launch blocker has no safe automatic action/,
  );
});

test('resolveRunnerLaunchBlockers retries auto-action once before reporting timeout', async () => {
  const commands: string[] = [];
  let now = 0;

  await assert.rejects(
    resolveRunnerLaunchBlockers(makeSlotVars(), 'mme-2:dev', 'cursor', 3_000, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      exec: async (_vars, command) => {
        commands.push(command);
        return { exitCode: 0, stdout: cursorWorkspaceTrustPane, stderr: '' };
      },
    }),
    /Auto-action was sent for: workspace-trust \(2 attempts\)/,
  );

  assert.equal(commands.filter((command) => command.includes('send-keys')).length, 2);
});

test('dispatch failure cleanup kills launched role runner and verifies exit', async () => {
  const calls: string[] = [];
  const vars = makeSlotVars();

  await cleanupLaunchedWorkerAfterDispatchFailure(vars, 'mme-2:dev', 'cursor', 'primary', {
    killAgentInSession: async (_vars, runner, role) => {
      calls.push(`kill:${runner}:${role}`);
    },
    waitForRunnerProcessExit: async (_vars, target, runner, timeoutMs) => {
      calls.push(`wait:${target}:${runner}:${timeoutMs}`);
    },
  });

  assert.deepEqual(calls, ['kill:cursor:primary', 'wait:mme-2:dev:cursor:5000']);
});

test('normalizeTicketRef only extracts standalone GitHub and Jira URLs', () => {
  assert.equal(
    normalizeTicketRef('https://github.com/example-org/example-mobile/pull/42'),
    'example-org/example-mobile#42',
  );
  assert.equal(
    normalizeTicketRef('https://example-app.atlassian.net/browse/PROJ-3060'),
    'PROJ-3060',
  );
  assert.equal(
    normalizeTicketRef('please review https://github.com/deeeed/farmslot/pull/73 for context'),
    'please review https://github.com/deeeed/farmslot/pull/73 for context',
  );
});

test('assertTicketRefMatchesProjectRepo rejects GitHub refs for another project repo', () => {
  assert.doesNotThrow(() => {
    assertTicketRefMatchesProjectRepo(
      'example-org/example-mobile#42',
      'example-mobile-farm',
      'example-org/example-mobile',
    );
  });
  assert.throws(
    () =>
      assertTicketRefMatchesProjectRepo(
        'deeeed/farmslot#73',
        'example-mobile-farm',
        'example-org/example-mobile',
      ),
    /belongs to deeeed\/farmslot, but project example-mobile-farm is configured for example-org\/example-mobile/,
  );
});

test('resolvePreviewModel uses Cursor default for missing or unknown slot model', () => {
  assert.equal(
    resolvePreviewModel(makeSlot({ runner: 'cursor', model: null })),
    DEFAULT_CURSOR_MODEL,
  );
  assert.equal(
    resolvePreviewModel(makeSlot({ runner: 'cursor', model: 'unknown' })),
    DEFAULT_CURSOR_MODEL,
  );
});

test('dispatch preview displays Cursor composer-2.5 instead of Claude default', () => {
  const result = resolveDispatchPreviewFromFleet(
    { project: 'farmslot-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1' },
    [makeSlot({ lifecycle: 'ready', phase: null, branch: 'main', runner: 'cursor', model: null })],
  );

  assert.equal(result.preview.runner, 'cursor');
  assert.equal(result.preview.model, DEFAULT_CURSOR_MODEL);
});

test('dispatch preview echoes the domain overlay and omits it when unset', () => {
  const slots = [makeSlot({ lifecycle: 'ready', phase: null, branch: 'main' })];
  const withDomain = resolveDispatchPreviewFromFleet(
    { project: 'farmslot-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1', domain: 'blue' },
    slots,
  );
  assert.equal(withDomain.preview.domain, 'blue');

  const withoutDomain = resolveDispatchPreviewFromFleet(
    { project: 'farmslot-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1' },
    slots,
  );
  assert.equal('domain' in withoutDomain.preview, false);
});

test('flowTypeToKey ignores eval wrapper flow names', () => {
  assert.equal(flowTypeToKey('fix-bug'), 'fix');
  assert.equal(flowTypeToKey('dev'), 'dev');
  assert.equal(flowTypeToKey('eval-candidate-replay'), '');
  assert.equal(flowTypeToKey(''), '');
});

test('canonicalAgentContextTarget prefers named role window over numeric target', () => {
  assert.equal(
    canonicalAgentContextTarget({
      session: 'mm-2',
      window: 'dev',
      pane: '1',
      target: 'mm-2:1.1',
    }),
    'mm-2:dev',
  );
  assert.equal(
    canonicalAgentContextTarget({
      session: 'mm-2',
      window: '1',
      pane: '0',
      target: 'mm-2:1.0',
    }),
    'mm-2:1.0',
  );
});

test('parseCapturedAgentPaneTarget falls back to numeric window when name is empty', () => {
  assert.deepEqual(parseCapturedAgentPaneTarget('mme-4', 'mme-4:1.0|'), {
    session: 'mme-4',
    window: '1',
    pane: '0',
    target: 'mme-4:1.0',
  });
});

test('findAffinitySlot respects family/lane/variant identity when provided', () => {
  const matching = makeSlot({
    slot: 'held-good',
    currentFamilyId: 'family-1',
    currentLane: 'comparison',
    currentVariant: 'claude',
    branch: 'review/example-org-example-mobile-42-claude',
  });
  const mismatched = makeSlot({
    slot: 'held-bad',
    currentFamilyId: 'family-2',
    currentLane: 'comparison',
    currentVariant: 'codex',
    branch: 'review/example-org-example-mobile-42-codex',
  });

  const found = findAffinitySlot(
    [mismatched, matching],
    'farmslot-farm',
    'example-org/example-mobile#42',
    {
      familyId: 'family-1',
      lane: 'comparison',
      variant: 'claude',
    },
  );

  assert.equal(found?.slot, 'held-good');
});

test('findAffinitySlot falls back to ticket affinity when identity fields are absent', () => {
  const slot = makeSlot({
    slot: 'held-legacy',
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    branch: 'review/example-org-example-mobile-42',
  });
  const found = findAffinitySlot([slot], 'farmslot-farm', 'example-org/example-mobile#42', {
    familyId: 'family-1',
    lane: 'production',
    variant: null,
  });
  assert.equal(found?.slot, 'held-legacy');
});

test('findAffinitySlot rejects legacy/null identity for comparison lane', () => {
  const slot = makeSlot({
    slot: 'held-legacy',
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    branch: 'review/example-org-example-mobile-42',
  });
  const found = findAffinitySlot([slot], 'farmslot-farm', 'example-org/example-mobile#42', {
    familyId: 'family-1',
    lane: 'comparison',
    variant: 'claude',
  });
  assert.equal(found, null);
});

test('evaluateSlotIdentityPolicy keeps legacy null identity permissive for production', () => {
  const result = evaluateSlotIdentityPolicy(
    {
      runId: 'old-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: null,
      lane: null,
      variant: null,
    },
    {
      runId: 'new-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'production',
      variant: null,
    },
    'interactive',
  );
  assert.equal(result.action, 'warn');
});

test('evaluateSlotIdentityPolicy blocks comparison reuse when identity mismatches', () => {
  const result = evaluateSlotIdentityPolicy(
    {
      runId: 'old-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: null,
      lane: null,
      variant: null,
    },
    {
      runId: 'new-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'comparison',
      variant: 'claude',
    },
    'interactive',
  );
  assert.equal(result.action, 'block');
});

test('evaluateSlotIdentityPolicy blocks comparison reuse when existing run id is missing', () => {
  const result = evaluateSlotIdentityPolicy(
    {
      runId: null,
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'comparison',
      variant: 'claude',
    },
    {
      runId: 'new-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'comparison',
      variant: 'claude',
    },
    'interactive',
  );
  assert.equal(result.action, 'block');
});

test('evaluateSlotIdentityPolicy allows forked comparison on a fresh slot when parentRunId is set', () => {
  // Forked-comparison case: collision-redirect / "Re-run alongside" landed on
  // a freshly prepared slot (existing identity all-null). The parent reference
  // signals legitimacy, and an empty slot has no residual state to clash with.
  const result = evaluateSlotIdentityPolicy(
    { runId: null, ticket: null, flow: null, familyId: null, lane: null, variant: null },
    {
      runId: 'forked-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'comparison',
      variant: 'codex-gpt-5-5',
      parentRunId: 'parent-run',
    },
    'interactive',
  );
  assert.equal(result.action, 'allow');
});

test('evaluateSlotIdentityPolicy allows comparison sibling on a fresh slot when familyId is set', () => {
  // Sibling-comparison case: `run.create` clustered the run under a familyId
  // and routed it to a freshly prepared slot. The family reference proves
  // legitimacy (run.create blocks unknown families) and the empty slot has no
  // residual identity to clash with.
  const result = evaluateSlotIdentityPolicy(
    { runId: null, ticket: null, flow: null, familyId: null, lane: null, variant: null },
    {
      runId: 'sibling-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'comparison',
      variant: 'codex-gpt-5-5',
    },
    'interactive',
  );
  assert.equal(result.action, 'allow');
});

test('evaluateSlotIdentityPolicy blocks comparison on a fresh slot when neither parent nor family ref is set', () => {
  // Defence-in-depth: a comparison run with no familyId and no parentRunId is
  // a misconfigured dispatch (run.create normally fills familyId). Stay strict.
  const result = evaluateSlotIdentityPolicy(
    { runId: null, ticket: null, flow: null, familyId: null, lane: null, variant: null },
    {
      runId: 'orphan-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: null,
      lane: 'comparison',
      variant: 'codex-gpt-5-5',
    },
    'interactive',
  );
  assert.equal(result.action, 'block');
});

test('evaluateSlotIdentityPolicy scrubs validation mismatches', () => {
  const result = evaluateSlotIdentityPolicy(
    {
      runId: 'old-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-2',
      lane: 'production',
      variant: null,
    },
    {
      runId: 'new-run',
      ticket: 'example-org/example-mobile#42',
      flow: 'review-pr',
      familyId: 'family-1',
      lane: 'validation',
      variant: null,
    },
    'validation',
  );
  assert.equal(result.action, 'scrub');
});

test('evaluateSlotIdentityPolicy allows same-family follow-up reuse on held slots', () => {
  const result = evaluateSlotIdentityPolicy(
    {
      runId: 'parent-run',
      ticket: 'PROJ-2794',
      flow: 'fix-bug',
      familyId: 'family-1',
      lane: 'production',
      variant: null,
    },
    {
      runId: 'child-run',
      ticket: 'example-org/example-browser#41720',
      flow: 'pr-complete',
      familyId: 'family-1',
      lane: 'production',
      variant: null,
    },
    'interactive',
  );
  assert.equal(result.action, 'allow');
});

test('resolveDispatchPreviewFromFleet prefers identity-matching held comparison slot', () => {
  const held = makeSlot({
    slot: 'held-slot',
    branch: 'review/example-org-example-mobile-42-codex',
    currentFamilyId: 'family-2',
    currentLane: 'comparison',
    currentVariant: 'codex',
    runner: 'codex',
    model: 'gpt-5.5',
  });
  const ready = makeSlot({
    slot: 'ready-slot',
    lifecycle: 'ready',
    phase: null,
    branch: 'main',
  });
  const preview = resolveDispatchPreviewFromFleet(
    {
      project: 'farmslot-farm',
      flowType: 'review-pr',
      ticketOrPr: 'example-org/example-mobile#42',
      familyId: 'family-2',
      lane: 'comparison',
      variant: 'codex',
    },
    [ready, held],
  );
  assert.equal(preview.preview.slotId, 'held-slot');
  assert.equal(preview.preview.runner, 'codex');
});

test('resolveDispatchPreviewFromFleet avoids mismatched held comparison slot and falls back to ready slot', () => {
  const heldMismatch = makeSlot({
    slot: 'held-mismatch',
    branch: 'review/example-org-example-mobile-42-claude',
    currentFamilyId: 'family-other',
    currentLane: 'comparison',
    currentVariant: 'claude',
  });
  const ready = makeSlot({
    slot: 'ready-slot',
    lifecycle: 'ready',
    phase: null,
    branch: 'main',
  });
  const preview = resolveDispatchPreviewFromFleet(
    {
      project: 'farmslot-farm',
      flowType: 'review-pr',
      ticketOrPr: 'example-org/example-mobile#42',
      familyId: 'family-2',
      lane: 'comparison',
      variant: 'codex',
    },
    [heldMismatch, ready],
  );
  assert.equal(preview.preview.slotId, 'ready-slot');
});

test('resolveDispatchSafetyTier prefers explicit params', () => {
  assert.equal(
    resolveDispatchSafetyTier({
      paramsTier: 'sandboxed',
      runTier: 'dangerous',
      projectDefaultRaw: 'full-auto',
    }),
    'sandboxed',
  );
});

test('resolveDispatchSafetyTier falls back to run record before project default', () => {
  assert.equal(
    resolveDispatchSafetyTier({
      paramsTier: undefined,
      runTier: 'full-auto',
      projectDefaultRaw: 'dangerous',
    }),
    'full-auto',
  );
});

test('resolveDispatchSafetyTier uses project default when no Run (scripts/dispatch.sh path)', () => {
  assert.equal(
    resolveDispatchSafetyTier({
      paramsTier: undefined,
      runTier: undefined,
      projectDefaultRaw: 'dangerous',
    }),
    'dangerous',
  );
});

test('resolveDispatchSafetyTier ignores malformed project default value', () => {
  assert.equal(
    resolveDispatchSafetyTier({
      paramsTier: undefined,
      runTier: undefined,
      projectDefaultRaw: 'yolo',
    }),
    undefined,
  );
});

test('resolveDispatchSafetyTier returns undefined when every source is absent', () => {
  assert.equal(
    resolveDispatchSafetyTier({
      paramsTier: undefined,
      runTier: undefined,
      projectDefaultRaw: undefined,
    }),
    undefined,
  );
});

test('slotScore penalizes stale branches by default', () => {
  const mainSlot = makeSlot({
    branch: 'main',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const staleSlot = makeSlot({
    branch: 'feat/unrelated',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  assert.equal(slotScore(mainSlot), 0);
  assert.equal(slotScore(staleSlot), 50);
});

test('slotScore treats configured tracking branches as idle', () => {
  const projectConfigs = {
    'farmslot-farm': {
      defaultBranch: 'main',
      slotTrackingBranch: 'wt/{{session}}',
      worktreeBase: '/Users/deeeed/dev/farmslot-wt',
    },
  };
  const trackingSlot = makeSlot({
    slot: 'macwork-ff-2',
    project: 'farmslot-farm',
    branch: 'wt/ff-2',
    session: 'ff-2',
    linkedWorktree: true,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const featureSlot = makeSlot({
    slot: 'macwork-ff-3',
    project: 'farmslot-farm',
    branch: 'feat/demo',
    session: 'ff-3',
    linkedWorktree: true,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });

  assert.equal(isDispatchStaleBranch(trackingSlot, projectConfigs), false);
  assert.equal(isDispatchStaleBranch(featureSlot, projectConfigs), true);
  assert.equal(slotScore(trackingSlot, undefined, { projectConfigs }), 0);
  assert.equal(slotScore(featureSlot, undefined, { projectConfigs }), 50);
});

test('slotScore prefers a same-family stale slot over unrelated main', () => {
  const familySlot = makeSlot({
    branch: 'feat/perps-e2e-validation',
    currentFamilyId: 'family-1',
    lifecycle: 'ready',
    phase: null,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const mainSlot = makeSlot({
    branch: 'main',
    lifecycle: 'ready',
    phase: null,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });

  assert.ok(
    slotScore(familySlot, undefined, { familyId: 'family-1' }) <
      slotScore(mainSlot, undefined, { familyId: 'family-1' }),
    'same-family slot wins even when it is not on main',
  );
  assert.ok(
    slotScore(familySlot, undefined, { familyId: 'other-family' }) >
      slotScore(mainSlot, undefined, { familyId: 'other-family' }),
    'unrelated stale slot still loses to main',
  );
});

test('resolveDispatchFamilyContext leaves standalone PR follow-ups unlinked when no parent run exists', () => {
  const context = resolveDispatchFamilyContext(
    {
      project: 'metamask-core-farm',
      flowType: 'pr-complete',
      ticketOrPr: 'https://github.com/MetaMask/core/pull/9009',
    },
    [],
  );

  assert.deepEqual(context, {});
});

test('resolveDispatchFamilyContext infers PR-complete lineage from prior dev PR number', () => {
  const parent = {
    id: 'run-root',
    project: 'metamask-core-farm',
    flowType: 'dev',
    ticketOrPr: 'TAT-3182',
    prNumber: 9009,
    taskFile: 'tasks/dev/TAT-3182/TASK.md',
    familyId: 'family-root',
    familyRootTicketOrPr: 'TAT-3182',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-02T00:00:00Z',
  } as unknown as Run;

  const context = resolveDispatchFamilyContext(
    {
      project: 'metamask-core-farm',
      flowType: 'pr-complete',
      ticketOrPr: 'https://github.com/MetaMask/core/pull/9009',
    },
    [parent],
  );

  assert.deepEqual(context, {
    familyId: 'family-root',
    parentRunId: 'run-root',
    familyRootTicketOrPr: 'TAT-3182',
    inferredFromParentRunId: 'run-root',
  });
});

test('resolveDispatchFamilyContext infers PR-complete lineage from prior run branch', () => {
  const parent = {
    id: 'run-root',
    project: 'metamask-core-farm',
    flowType: 'dev',
    ticketOrPr: 'TAT-9009',
    prNumber: null,
    branch: 'feat/perps-centralize-market-category-filter',
    taskFile: 'tasks/dev/TAT-9009/TASK.md',
    familyId: 'family-root',
    familyRootTicketOrPr: 'TAT-9009',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-02T00:00:00Z',
  } as unknown as Run;

  const context = resolveDispatchFamilyContext(
    {
      project: 'metamask-core-farm',
      flowType: 'pr-complete',
      ticketOrPr: 'MetaMask/core#9009',
      targetBranch: 'feat/perps-centralize-market-category-filter',
    },
    [parent],
  );

  assert.equal(context.familyId, 'family-root');
  assert.equal(context.parentRunId, 'run-root');
});

test('resolveDispatchTargetBranch feeds branch-based family inference for PR re-entry', async () => {
  const branch = 'feat/perps-centralize-market-category-filter';
  const parent = {
    id: 'run-root',
    project: 'metamask-core-farm',
    flowType: 'dev',
    ticketOrPr: 'TAT-9009',
    prNumber: null,
    branch,
    taskFile: 'tasks/dev/TAT-9009/TASK.md',
    familyId: 'family-root',
    familyRootTicketOrPr: 'TAT-9009',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-02T00:00:00Z',
  } as unknown as Run;
  const prRef = 'https://github.com/MetaMask/core/pull/9009';

  const targetBranch = await resolveDispatchTargetBranch(
    {
      project: 'metamask-core-farm',
      flowType: 'pr-complete',
      ticketOrPr: prRef,
    },
    {
      fleetSlots: [
        makeSlot({
          project: 'metamask-core-farm',
          currentTicketOrPr: 'MetaMask/core#9009',
          branch,
        }),
      ],
      logPrefix: 'test',
    },
  );
  const context = resolveDispatchFamilyContext(
    {
      project: 'metamask-core-farm',
      flowType: 'pr-complete',
      ticketOrPr: prRef,
      targetBranch,
    },
    [parent],
  );

  assert.equal(targetBranch, branch);
  assert.equal(context.parentRunId, 'run-root');
  assert.equal(context.familyId, 'family-root');
});

test('resolveDispatchPreviewFromFleet honors allowedSlots', () => {
  const excluded = makeSlot({
    slot: 'mini-mme-1',
    machine: 'mini',
    branch: 'main',
    lifecycle: 'ready',
    agent: 'idle',
    health: { ssh: 'OK', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const included = makeSlot({
    slot: 'runner-browser-1',
    machine: 'runner-local',
    branch: 'main',
    lifecycle: 'ready',
    agent: 'idle',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });

  const result = resolveDispatchPreviewFromFleet(
    {
      project: 'farmslot-farm',
      flowType: 'fix-bug',
      ticketOrPr: 'PROJ-1',
      allowedSlots: ['runner-browser-1'],
    },
    [excluded, included],
  );
  assert.equal(result.preview.slotId, 'runner-browser-1');

  // Allow list excludes every free slot → hard error, no silent fallback.
  assert.throws(
    () =>
      resolveDispatchPreviewFromFleet(
        {
          project: 'farmslot-farm',
          flowType: 'fix-bug',
          ticketOrPr: 'PROJ-1',
          allowedSlots: ['does-not-exist'],
        },
        [excluded, included],
      ),
    /No slots found for project farmslot-farm within allowed slots/,
  );
});

test('resolveDispatchPreviewFromFleet prefers same-family ready slot for follow-ups', () => {
  const mainSlot = makeSlot({
    slot: 'macwork-core-5',
    branch: 'main',
    lifecycle: 'ready',
    phase: null,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const familySlot = makeSlot({
    slot: 'macwork-core-1',
    branch: 'feat/perps-e2e-validation',
    lifecycle: 'ready',
    phase: null,
    currentFamilyId: 'family-root',
    currentLane: 'production',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });

  const result = resolveDispatchPreviewFromFleet(
    {
      project: 'farmslot-farm',
      flowType: 'pr-complete',
      ticketOrPr: 'example-org/example-mobile#9009',
      familyId: 'family-root',
    },
    [mainSlot, familySlot],
  );

  assert.equal(result.preview.slotId, 'macwork-core-1');
});

test('findAffinitySlot respects allowedSlots', () => {
  // Branch must match the ticket-slug that findAffinitySlot derives from ticketOrPr.
  const ticket = 'example-org/example-mobile#42';
  const slug = ticket.replace(/[#/]/g, '-').toLowerCase();
  const matching = makeSlot({
    slot: 'runner-browser-2',
    machine: 'runner-local',
    branch: `feat/${slug}`,
    lifecycle: 'held',
    agent: 'idle',
  });
  const sameBranchDifferentMachine = makeSlot({
    slot: 'mini-mme-1',
    machine: 'mini',
    branch: `feat/${slug}`,
    lifecycle: 'held',
    agent: 'idle',
  });
  const found = findAffinitySlot([sameBranchDifferentMachine, matching], 'farmslot-farm', ticket, {
    allowedSlots: ['runner-browser-2'],
  });
  assert.equal(found?.slot, 'runner-browser-2');
});

test('slotScore flips the stale penalty into a bonus when targetBranch matches', () => {
  const prBranch = 'fix/proj-2802-keyboard-order-entry-ux';
  const prSlot = makeSlot({
    branch: prBranch,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const mainSlot = makeSlot({
    branch: 'main',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const otherStale = makeSlot({
    branch: 'feat/unrelated',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });

  // Without the hint the PR slot would lose to main
  assert.ok(slotScore(prSlot) > slotScore(mainSlot), 'stale branch loses without hint');
  // With the hint the PR slot wins
  assert.ok(
    slotScore(prSlot, prBranch) < slotScore(mainSlot, prBranch),
    'matching branch wins with hint',
  );
  // Unrelated stale slot still penalized even when the hint is set
  assert.ok(slotScore(otherStale, prBranch) > slotScore(prSlot, prBranch));
});

test('slotScore keeps red host-load penalty dominant over target branch bonus', () => {
  const prBranch = 'fix/proj-2802-keyboard-order-entry-ux';
  const healthyMain = makeSlot({
    branch: 'main',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const yellowPrSlot = makeSlot({
    branch: prBranch,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
    hostLoad: { cpuPercent: 75, memoryPercent: 60, diskPercent: 40, headroom: 'yellow' },
  });
  const redPrSlot = makeSlot({
    branch: prBranch,
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
    hostLoad: { cpuPercent: 95, memoryPercent: 90, diskPercent: 50, headroom: 'red' },
  });

  assert.ok(slotScore(yellowPrSlot, prBranch) < slotScore(healthyMain, prBranch));
  assert.ok(slotScore(redPrSlot, prBranch) > slotScore(healthyMain, prBranch));
});

test('isFreeSlot rejects ready working slots even when run metadata is temporarily clear', () => {
  const transitionMidpoint = makeSlot({
    lifecycle: 'ready',
    agent: 'working',
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    taskPhase: null,
  });
  assert.equal(isFreeSlot(transitionMidpoint), false);

  const activeRun = makeSlot({
    lifecycle: 'ready',
    agent: 'working',
    currentRunId: 'run-1',
    taskPhase: null,
  });
  assert.equal(isFreeSlot(activeRun), false);

  const activeTask = makeSlot({
    lifecycle: 'ready',
    agent: 'working',
    currentRunId: null,
    taskPhase: 'Fix 12/30',
  });
  assert.equal(isFreeSlot(activeTask), false);
});

test('validateSlot rejects ready working slots even when run metadata is temporarily clear', () => {
  const transitionMidpoint = makeSlot({
    lifecycle: 'ready',
    agent: 'working',
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    taskPhase: null,
  });
  assert.equal(validateSlot(transitionMidpoint), 'Agent is working');

  const activeRun = makeSlot({
    lifecycle: 'ready',
    agent: 'working',
    currentRunId: 'run-1',
    taskPhase: null,
  });
  assert.equal(validateSlot(activeRun), 'Agent is working');
});

test('resolveJiraTargetBranchFromFleet reuses a free slot on the same Jira branch', () => {
  const target = makeSlot({
    project: 'example-mobile-farm',
    branch: 'fix/proj-3093-perps-valierror-non-evm-addres',
    lifecycle: 'ready',
    agent: 'idle',
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    taskPhase: null,
  });
  const unrelated = makeSlot({
    project: 'example-mobile-farm',
    branch: 'fix/proj-2971-fix-perps-cancel-handling',
    lifecycle: 'ready',
    agent: 'idle',
  });

  assert.equal(
    resolveJiraTargetBranchFromFleet([unrelated, target], 'example-mobile-farm', 'PROJ-3093'),
    target.branch,
  );
  assert.equal(
    resolveJiraTargetBranchFromFleet(
      [target],
      'example-mobile-farm',
      'example-org/example-mobile#29420',
    ),
    undefined,
  );
});

test('branchContainsJiraKey requires token boundaries around Jira key', () => {
  assert.equal(branchContainsJiraKey('fix/proj-3093-perps-valierror', 'PROJ-3093'), true);
  assert.equal(branchContainsJiraKey('fix/PROJ-3093-perps-valierror', 'PROJ-3093'), true);
  assert.equal(branchContainsJiraKey('fix/proj-3093', 'PROJ-3093'), true);
  assert.equal(branchContainsJiraKey('fix/proj-3093-perps-valierror', 'PROJ-309'), false);
  assert.equal(branchContainsJiraKey('fix/xproj-3093-perps-valierror', 'PROJ-3093'), false);
});

test('resolveJiraTargetBranchFromFleet does not match Jira key prefixes', () => {
  const wrongPrefix = makeSlot({
    project: 'example-mobile-farm',
    branch: 'fix/proj-3093-perps-valierror-non-evm-addres',
    lifecycle: 'ready',
    agent: 'idle',
  });

  assert.equal(
    resolveJiraTargetBranchFromFleet([wrongPrefix], 'example-mobile-farm', 'PROJ-309'),
    undefined,
  );
});

test('resolveDispatchPreviewFromFleet avoids stale comparison identity in scored fallback', () => {
  const mismatchedReady = makeSlot({
    slot: 'ready-stale-identity',
    lifecycle: 'ready',
    phase: null,
    branch: 'main',
    currentRunId: 'old-run',
    currentFamilyId: 'family-other',
    currentLane: 'comparison',
    currentVariant: 'claude',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });
  const cleanReady = makeSlot({
    slot: 'ready-clean',
    lifecycle: 'ready',
    phase: null,
    branch: 'main',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  });

  const preview = resolveDispatchPreviewFromFleet(
    {
      project: 'farmslot-farm',
      flowType: 'review-pr',
      ticketOrPr: 'example-org/example-mobile#42',
      familyId: 'family-2',
      lane: 'comparison',
      variant: 'codex',
    },
    [mismatchedReady, cleanReady],
  );

  assert.equal(preview.preview.slotId, 'ready-clean');
});

test('buildComparisonVariant produces matching tags for the dispatch wizard and re-run-alongside button', () => {
  // Same inputs from both UI callers must produce identical output — drift here
  // would let the duplicate-run guard reject runs that were supposed to be valid
  // forks (the rationale for lifting this helper into protocol).
  assert.equal(buildComparisonVariant('codex', 'gpt-5.5'), 'codex-gpt-5-5');
  assert.equal(buildComparisonVariant('claude', 'opus'), 'claude-opus');
  assert.equal(buildComparisonVariant('claude', 'sonnet'), 'claude-sonnet');
});

test('buildComparisonVariant collapses adjacent and trailing dashes from non-alphanumeric model chars', () => {
  // Keeps the variant URL/shell-friendly even when models grow extra punctuation.
  assert.equal(buildComparisonVariant('codex', 'gpt-5.5-mini'), 'codex-gpt-5-5-mini');
  assert.equal(buildComparisonVariant('claude', 'sonnet@beta'), 'claude-sonnet-beta');
  assert.equal(buildComparisonVariant('codex', 'gpt-5..5'), 'codex-gpt-5-5');
});

test('buildComparisonVariant returns empty when either side is missing', () => {
  // Caller (re-run-alongside button) skips emitting the URL param when empty,
  // so a partial run state never produces a malformed variant.
  assert.equal(buildComparisonVariant(null, 'opus'), '');
  assert.equal(buildComparisonVariant('claude', null), '');
  assert.equal(buildComparisonVariant('', 'opus'), '');
  assert.equal(buildComparisonVariant(undefined, undefined), '');
});

test('buildComparisonVariant returns empty when model sanitizes to empty rather than producing a trailing dash', () => {
  // Without the safeModel guard, '!!!' sanitized to '' and `${runner}-${safeModel}`
  // produced 'codex-' — a stray trailing dash the URL/shell-friendly contract forbids.
  assert.equal(buildComparisonVariant('codex', '!!!'), '');
  assert.equal(buildComparisonVariant('claude', '---'), '');
});

// ─── Branch-affinity nudge eligibility ───
//
// Cover the pure filter that the headless decision-card path + dispatch.candidates rely on.
// The full collector (collectBranchAffinityNudgeCandidates) layers SSH/tmux IO on top — those
// integration paths are exercised live; tests here pin the shape of the gate that decides
// which busy slots ever reach that IO step.

const PROJECT = 'farmslot-farm';
const PR_TICKET = 'example-org/example-browser#41949';
const PR_BRANCH = 'feat/proj-2802-keyboard-order-entry-ux';

function makeBusyClaudeSlot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return makeSlot({
    slot: overrides.slot ?? 'runner-browser-2',
    project: overrides.project ?? PROJECT,
    lifecycle: overrides.lifecycle ?? 'ready',
    agent: overrides.agent ?? 'working',
    branch: overrides.branch ?? PR_BRANCH,
    runner: overrides.runner ?? 'claude',
    ...overrides,
  });
}

test('selectBranchAffinityEligibleSlots surfaces a busy claude slot whose branch matches the PR head', () => {
  const slot = makeBusyClaudeSlot();
  const eligible = selectBranchAffinityEligibleSlots([slot], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
  });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].slot.slot, slot.slot);
  // targetBranch exact match → strongest signal, recorded as 'pr-number' even when prHealth.pr is null.
  assert.equal(eligible[0].prMatchKind, 'pr-number');
  assert.equal(eligible[0].canNudge, true);
});

test('selectBranchAffinityEligibleSlots returns empty for comparison lane (defends ADR-024 §7 scrub-between-siblings)', () => {
  const slot = makeBusyClaudeSlot();
  const eligible = selectBranchAffinityEligibleSlots([slot], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
    lane: 'comparison',
  });
  assert.equal(eligible.length, 0);
});

test('selectBranchAffinityEligibleSlots excludes idle slots — agent must be working', () => {
  const idle = makeBusyClaudeSlot({ agent: 'idle' });
  const eligible = selectBranchAffinityEligibleSlots([idle], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
  });
  assert.equal(eligible.length, 0);
});

test('selectBranchAffinityEligibleSlots excludes manual/disabled/held lifecycles even when worker is active', () => {
  for (const lifecycle of ['manual', 'disabled', 'held'] as const) {
    const slot = makeBusyClaudeSlot({ lifecycle });
    const eligible = selectBranchAffinityEligibleSlots([slot], PROJECT, PR_TICKET, {
      targetBranch: PR_BRANCH,
    });
    assert.equal(eligible.length, 0, `lifecycle=${lifecycle} should be excluded`);
  }
});

test('selectBranchAffinityEligibleSlots enables Codex TUI nudges but keeps OpenCode fresh-only', () => {
  // Operator wants to see "this slot is on the PR's branch" for every runner.
  // TUI-backed runners can be nudged; non-TUI runners remain Fresh-only.
  const codex = makeBusyClaudeSlot({ slot: 'mini-mme-2', runner: 'codex' });
  const opencode = makeBusyClaudeSlot({ slot: 'mini-mme-3', runner: 'opencode' });
  const eligible = selectBranchAffinityEligibleSlots([codex, opencode], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
  });
  assert.equal(eligible.length, 2);
  assert.deepEqual(eligible.map((e) => [e.slot.slot, e.canNudge]).sort(), [
    ['mini-mme-2', true],
    ['mini-mme-3', false],
  ]);
});

test('selectBranchAffinityRefreshSlots refreshes non-nudge working slots for fresh-only branch reuse', () => {
  const claude = makeBusyClaudeSlot({ slot: 'runner-browser-2', runner: 'claude' });
  const opencode = makeBusyClaudeSlot({ slot: 'runner-browser-3', runner: 'opencode' });
  const idle = makeBusyClaudeSlot({ slot: 'runner-browser-4', agent: 'idle' });
  const manual = makeBusyClaudeSlot({ slot: 'runner-browser-5', lifecycle: 'manual' });

  const refreshSlots = selectBranchAffinityRefreshSlots([claude, opencode, idle, manual]);

  assert.deepEqual(
    refreshSlots.map((slot) => slot.slot),
    ['runner-browser-2', 'runner-browser-3'],
  );
});

test('selectBranchAffinityEligibleSlots prefers targetBranch exact match over PR-number / slug paths', () => {
  // Exact targetBranch wins regardless of prHealth state — wizard already authorized this
  // branch as the PR head against pr.list.
  const slot = makeBusyClaudeSlot({ branch: PR_BRANCH, prHealth: undefined });
  const eligible = selectBranchAffinityEligibleSlots([slot], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
  });
  assert.equal(eligible[0].prMatchKind, 'pr-number');
});

test('selectBranchAffinityEligibleSlots falls back to branch-slug match when targetBranch is unset', () => {
  // Branch named after the canonical ticket slug `example-org-example-browser-41949`. Slug
  // contains the PR number digits but the slot's prHealth.pr is null — the slug fallback path.
  const slug = PR_TICKET.replace(/[#/]/g, '-').toLowerCase();
  const slot = makeBusyClaudeSlot({ branch: `feat/${slug}-extra` });
  const eligible = selectBranchAffinityEligibleSlots([slot], PROJECT, PR_TICKET);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].prMatchKind, 'branch-slug');
});

test('selectBranchAffinityEligibleSlots rejects slot when prHealth.pr contradicts requested PR number', () => {
  // Branch slug mentions PR# but slot's prHealth says it's actually loaded for a different PR.
  // Reusing this slot under "branch-slug" semantics would be wrong — defend in depth.
  const slug = PR_TICKET.replace(/[#/]/g, '-').toLowerCase();
  const slot = makeBusyClaudeSlot({
    branch: `feat/${slug}`,
    prHealth: {
      pr: 99999,
      conflict: false,
      ciPassed: 0,
      ciFailed: 0,
      ciPending: 0,
      ciTotal: 0,
      updatedAt: '2026-04-30T00:00:00Z',
    },
  });
  const eligible = selectBranchAffinityEligibleSlots([slot], PROJECT, PR_TICKET);
  assert.equal(eligible.length, 0);
});

test('selectBranchAffinityEligibleSlots respects allowedSlots filter', () => {
  const a = makeBusyClaudeSlot({ slot: 'runner-browser-1' });
  const b = makeBusyClaudeSlot({ slot: 'runner-browser-2' });
  const eligible = selectBranchAffinityEligibleSlots([a, b], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
    allowedSlots: ['runner-browser-2'],
  });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].slot.slot, 'runner-browser-2');
});

test('selectBranchAffinityEligibleSlots filters by project — sibling project slots are invisible', () => {
  const otherProject = makeBusyClaudeSlot({
    slot: 'runner-mobile-1',
    project: 'example-mobile-farm',
  });
  const matching = makeBusyClaudeSlot({ slot: 'runner-browser-2' });
  const eligible = selectBranchAffinityEligibleSlots([otherProject, matching], PROJECT, PR_TICKET, {
    targetBranch: PR_BRANCH,
  });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].slot.slot, 'runner-browser-2');
});

test('classifyRefreshSlotAction throws PoolConfigError when vars.machine is empty', () => {
  // Pool misconfiguration must fail loud — otherwise !getNode('') silently
  // skips every refresh forever and dispatch.candidates surfaces stale data.
  assert.throws(
    () => classifyRefreshSlotAction('demo-1', { host: 'localhost', machine: '' }, () => undefined),
    (err: unknown) => {
      if (!(err instanceof PoolConfigError)) return false;
      if (!err.message.includes('demo-1')) return false;
      // Single-slot throw still exposes a 1-element slotIds list so consumers
      // can iterate uniformly regardless of aggregate vs leaf shape.
      if (err.slotId !== 'demo-1') return false;
      if (!Array.isArray(err.slotIds) || err.slotIds.length !== 1 || err.slotIds[0] !== 'demo-1')
        return false;
      return true;
    },
  );
});

test('PoolConfigError aggregate form exposes structured slotIds list', () => {
  const err = new PoolConfigError(['mini-mme-1', 'runner-a-mm-2'], 'pool config error: two slots');
  assert.deepEqual([...err.slotIds], ['mini-mme-1', 'runner-a-mm-2']);
  assert.equal(err.slotId, 'mini-mme-1');
});

test('classifyRefreshSlotAction skips remote slot with no connected node agent', () => {
  // The whole point of the seam: avoid the 15s waitForNode hang per node-rpc.ts
  // when a remote node is offline.
  const action = classifyRefreshSlotAction(
    'mini-mme-1',
    { host: 'mini.local', machine: 'mini' },
    () => undefined,
  );
  assert.equal(action, 'skip-disconnected');
});

test('classifyRefreshSlotAction refreshes remote slot when node agent is connected', () => {
  const action = classifyRefreshSlotAction(
    'mini-mme-1',
    { host: 'mini.local', machine: 'mini' },
    () => ({ ws: {}, machine: 'mini' }),
  );
  assert.equal(action, 'refresh');
});

test('classifyRefreshSlotAction refreshes local slot regardless of node connectivity', () => {
  const action = classifyRefreshSlotAction(
    'demo-1',
    { host: 'localhost', machine: 'demo' },
    () => undefined,
  );
  assert.equal(action, 'refresh');
});
