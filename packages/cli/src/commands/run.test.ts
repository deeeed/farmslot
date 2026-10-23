import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { WebSocketServer } from 'ws';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  type ResultDecisionPayload,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import {
  assertRunGateActionAvailable,
  buildReviewChainResult,
  buildRunCreateParams,
  buildRunGateParams,
  formatResultDecision,
  formatReviewChainLine,
  formatRunListLines,
  formatRunSessionLines,
  formatRunStepTimingLines,
  parseAgentRole,
  parseOptionalPrNumber,
  parseTaskPath,
  registerRunCommand,
} from './run.js';

test('adopt-published-pr CLI requires explicit attestation and full publication inputs', () => {
  const program = new Command();
  registerRunCommand(program);
  const command = program.commands
    .find((entry) => entry.name() === 'run')!
    .commands.find((entry) => entry.name() === 'adopt-published-pr');
  assert.ok(command);
  for (const flag of ['--pr', '--head', '--reason', '--attest-reviewed-publication']) {
    assert.equal(command.options.find((option) => option.long === flag)?.mandatory, true);
  }
});

test('gate CLI serializes a written attestation reason with its visible package identity', () => {
  const decision = {
    id: 'gate',
    payload: {
      kind: 'ready',
      prPackage: { id: 'pkg', packageHash: 'hash', headSha: 'head', selectedEvidenceKeys: [] },
    },
  } as unknown as RunDecision;
  const run = { id: 'run' } as Run;
  const action = APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION;
  assert.throws(() => buildRunGateParams(run, decision, action, {}), /written reason/);
  assert.throws(
    () => buildRunGateParams(run, decision, 'approve-publish', { reason: 'waive' }),
    /requires attested/,
  );
  const params = buildRunGateParams(run, decision, action, {
    reason: ' Inspected retained evidence. ',
  });
  assert.equal(params.evidenceAttestationReason, 'Inspected retained evidence.');
  assert.equal(params.selectionData?.packageHash, 'hash');
  // Accepting review findings sends its own reason (ADR-065 Amendment 8).
  assert.throws(
    () => buildRunGateParams(run, decision, APPROVE_PUBLISH_UNRESOLVED_ACTION, {}),
    /requires --reason/,
  );
  const accepted = buildRunGateParams(run, decision, APPROVE_PUBLISH_UNRESOLVED_ACTION, {
    reason: ' The owner accepts it. ',
  });
  assert.equal(accepted.reason, 'The owner accepts it.');
  assert.equal(accepted.evidenceAttestationReason, undefined);
  const program = new Command();
  registerRunCommand(program);
  assert.ok(
    program.commands
      .find((command) => command.name() === 'run')!
      .commands.find((command) => command.name() === 'gate')!
      .options.some((option) => option.long === '--reason'),
  );
});

function repeatReviewRun(): Run {
  return {
    id: 'review-run-2',
    familyId: 'review-family',
    lane: 'production',
    flowType: 'review-pr',
    status: 'done',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#505',
    slotId: 'mini-ff-1',
    branch: 'feat/review',
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.6' },
    repeatReviewContext: {
      version: 1,
      chainId: 'review-run-1',
      generation: 2,
      priorRunId: 'review-run-1',
      priorFamilyId: 'review-family',
      repository: 'deeeed/farmslot',
      prNumber: 505,
      priorReviewedHeadSha: '111111111111',
      currentHeadSha: '222222222222',
      verdict: 'pending',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode: 'warm',
      validationDepth: 'static-code',
      session: {
        mode: 'warm',
        continuity: 'resumed',
        priorRunId: 'review-run-1',
        priorSessionId: 'session-1',
        sessionId: 'session-1',
      },
    },
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
}

test('run review-chain exposes stable JSON and human output shapes', () => {
  const result = buildReviewChainResult(repeatReviewRun());

  assert.equal(result.chain.length, 1);
  assert.equal(result.chain[0]?.generation, 2);
  assert.equal(result.chain[0]?.session?.continuity, 'resumed');
  assert.equal(
    formatReviewChainLine(result.chain[0]!),
    'G2 review-r  1111111 -> 2222222  warm/static-code  pending  unresolved pending  resumed',
  );
});

test('parseOptionalPrNumber accepts a positive integer and rejects the rest', () => {
  assert.equal(parseOptionalPrNumber(undefined), undefined);
  assert.equal(parseOptionalPrNumber(''), undefined);
  assert.equal(parseOptionalPrNumber('35145'), 35145);
  assert.throws(() => parseOptionalPrNumber('0'), /--pr must be a positive integer/);
  assert.throws(() => parseOptionalPrNumber('1.5'), /--pr must be a positive integer/);
});

test('run gate rejects actions that the pending decision does not offer', () => {
  const decision = {
    id: 'decision-1',
    type: 'engine_human_gate',
    title: 'Publish gate',
    description: 'Review package',
    actions: [
      { id: 'hold', label: 'Hold', style: 'secondary' },
      { id: 'approve-publish', label: 'Publish', style: 'primary' },
    ],
    createdAt: '2026-07-31T00:00:00.000Z',
  } as NonNullable<import('@farmslot/protocol').Run['decisions']>[number];

  assert.doesNotThrow(() => assertRunGateActionAvailable(decision, 'approve-publish'));
  assert.throws(
    () => assertRunGateActionAvailable(decision, 'request-review'),
    /Available actions: hold, approve-publish/,
  );
});

test('run gate pick on a slot picker sends the chosen slot', () => {
  const decision: RunDecision = {
    id: 'decision-slot',
    type: 'engine_no_suitable_slot',
    title: 'No suitable slot',
    description: 'All free slots score as stale.',
    actions: [
      { id: 'pick', label: 'Use Selected Slot', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: '2026-10-19T00:00:00.000Z',
    payload: {
      kind: 'slot_picker',
      project: 'example',
      reason: 'all_stale',
      candidates: [
        {
          slotId: 'node-example-1',
          score: 100,
          branch: 'main',
          lifecycle: 'ready',
          health: { ssh: 'LOCAL', device: '-', devserver: 'OFF', cdp: '-', fixtures: 'OK' },
          machine: 'node',
        },
      ],
    },
  };
  const run = { id: 'run' } as Run;
  assert.throws(
    () => buildRunGateParams(run, decision, 'pick', {}),
    /requires --slot <id>\. Candidates: node-example-1/,
  );
  assert.throws(
    () => buildRunGateParams(run, decision, 'abort', { slot: 'node-example-1' }),
    /--slot requires --action pick/,
  );
  const params = buildRunGateParams(run, decision, 'pick', { slot: ' node-example-1 ' });
  assert.deepEqual(params.selectionData, { slotId: 'node-example-1' });
});

test('run gate allows continue on a timed-out interactive handoff', () => {
  const decision = {
    id: 'handoff-1',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description:
      'The agent did not write a terminal signal.\n\nMonitor note: exceeded 90 minute timeout.',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: '2026-09-11T00:00:00.000Z',
  } as NonNullable<import('@farmslot/protocol').Run['decisions']>[number];

  assert.doesNotThrow(() => assertRunGateActionAvailable(decision, 'continue'));
  assert.throws(
    () => assertRunGateActionAvailable(decision, 'not-real'),
    /Available actions: signal-written, continue, abort/,
  );
});

test('run gate selection flags serialize the shared request and package binding', () => {
  const program = new Command();
  registerRunCommand(program);
  const command = program.commands
    .find((entry) => entry.name() === 'run')!
    .commands.find((entry) => entry.name() === 'gate')!;
  command.parseOptions([
    '--action',
    'request-review',
    '--runner',
    'codex',
    '--model',
    'gpt-6.1-sol',
    '--effort',
    'xhigh',
    '--review-mode',
    'cold',
    '--review-sequence',
    '[]',
  ]);
  const decision = {
    id: 'gate-1',
    payload: { kind: 'ready', prPackage: { id: 'package-1', packageHash: 'hash-1' } },
  } as unknown as Run['decisions'][number];
  const params = buildRunGateParams(repeatReviewRun(), decision, 'request-review', command.opts());
  assert.equal(params.runId, 'review-run-2');
  assert.equal(params.actionId, 'request-review');
  assert.equal(params.selectionData?.packageId, 'package-1');
  assert.deepEqual(params.selectionData?.reviewRequest, {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    mode: 'cold',
  });
});

test('run gate WARM requires and preserves retained lineage', () => {
  const run = repeatReviewRun();
  const decision = { id: 'gate-1' } as Run['decisions'][number];
  const selection = { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reviewMode: 'warm' };
  assert.throws(() => buildRunGateParams(run, decision, 'request-review', selection), /WARM/);
  const context = {
    reviewLineages: [{ repository: 'example/repo', prNumber: 1, reviewId: 'review-1' }],
  };
  const params = buildRunGateParams(run, decision, 'request-review', {
    ...selection,
    reviewContext: JSON.stringify(context),
  });
  assert.deepEqual((params.selectionData?.reviewRequest as { context: unknown }).context, context);
  assert.throws(() => buildRunGateParams(run, decision, 'hold', selection), /request-review/);
});

test('run gate Request Review continues the runner latest validated lineage WARM by default', () => {
  const option = {
    context: { reviewId: 'pipeline-review-run', familyId: 'family-1' },
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    reviewedAt: '2026-10-20T00:00:00Z',
  };
  const gate = (unavailableReason?: string): Run['decisions'][number] => ({
    id: 'gate-1',
    type: 'engine_human_gate',
    title: 'Ready',
    description: '',
    createdAt: '2026-10-20T00:00:00Z',
    actions: [],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: { files: 1, additions: 1, deletions: 0 },
      workerReport: '',
      branch: 'feature',
      reviewLineageOptions: [{ ...option, ...(unavailableReason ? { unavailableReason } : {}) }],
    },
  });
  const run = repeatReviewRun();
  assert.deepEqual(
    buildRunGateParams(run, gate(), 'request-review', { runner: 'codex' }).selectionData
      ?.reviewRequest,
    {
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      mode: 'warm',
      context: { reviewLineages: [option.context] },
    },
  );
  // Unavailable sessions refuse WARM; explicit COLD still wins.
  const context = { reviewLineages: [option.context] };
  assert.throws(
    () =>
      buildRunGateParams(
        run,
        gate('the retained reviewer belongs to a different slot'),
        'request-review',
        {
          runner: 'codex',
        },
      ),
    /Cannot resume this review: the retained reviewer belongs to a different slot/,
  );
  assert.deepEqual(
    buildRunGateParams(run, gate(), 'request-review', { runner: 'codex', reviewMode: 'cold' })
      .selectionData?.reviewRequest,
    { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'cold', context },
  );
});

test('run create builds params from a GitHub/Jira ticket source', () => {
  assert.deepEqual(
    buildRunCreateParams({
      project: 'audiolab-farm',
      flowType: 'dev',
      ticket: 'https://github.com/deeeed/audiolab/issues/414',
      slot: 'mini-audiolab-1',
      runner: 'codex',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'https://github.com/deeeed/audiolab/issues/414',
      slotId: 'mini-audiolab-1',
      runner: 'codex',
      skipPrepare: undefined,
      prepareProfile: undefined,
      mode: undefined,
      model: undefined,
      app: undefined,
      familyId: undefined,
      parentRunId: undefined,
      familyRootTicketOrPr: undefined,
      lane: undefined,
      variant: undefined,
    },
  );
});

test('run create omits the domain key entirely unless --domain is given', () => {
  const withoutDomain = buildRunCreateParams({
    project: 'audiolab-farm',
    flowType: 'dev',
    ticket: 'DEMO-414',
  });
  assert.equal('domain' in withoutDomain, false);

  const withDomain = buildRunCreateParams({
    project: 'audiolab-farm',
    flowType: 'dev',
    ticket: 'DEMO-414',
    domain: 'blue',
  });
  assert.equal(withDomain.domain, 'blue');
});

test('run create carries an exact execution-template id only when requested', () => {
  const params = buildRunCreateParams({
    project: 'example',
    flowType: 'fix-bug',
    ticket: 'PROJ-123',
    executionTemplate: 'fix-bug/trading-mobile',
  });
  assert.equal(params.executionTemplateId, 'fix-bug/trading-mobile');
});

test('run create builds params from an existing task file source', () => {
  assert.deepEqual(
    buildRunCreateParams({
      task: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      slot: 'mini-audiolab-1',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'DEMO-414',
      taskFile: path.resolve('projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md'),
      slotId: 'mini-audiolab-1',
      skipPrepare: undefined,
      prepareProfile: undefined,
      mode: undefined,
      runner: undefined,
      model: undefined,
      app: undefined,
      familyId: undefined,
      parentRunId: undefined,
      familyRootTicketOrPr: undefined,
      lane: undefined,
      variant: undefined,
    },
  );
});

test('run create forwards comparison lineage metadata', () => {
  assert.deepEqual(
    buildRunCreateParams({
      project: 'audiolab-farm',
      flowType: 'dev',
      ticket: 'DEMO-414',
      slot: 'mini-audiolab-1',
      runner: 'codex',
      model: 'gpt-5.5',
      familyId: 'family-1',
      parentRunId: 'parent-1',
      familyRootTicketOrPr: 'DEMO-414',
      lane: 'comparison',
      variant: 'comparison-codex',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'DEMO-414',
      slotId: 'mini-audiolab-1',
      runner: 'codex',
      model: 'gpt-5.5',
      skipPrepare: undefined,
      prepareProfile: undefined,
      mode: undefined,
      app: undefined,
      familyId: 'family-1',
      parentRunId: 'parent-1',
      familyRootTicketOrPr: 'DEMO-414',
      lane: 'comparison',
      variant: 'comparison-codex',
    },
  );
});

test('run create rejects ambiguous input sources', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'audiolab-farm',
        flowType: 'dev',
        ticket: 'DEMO-414',
        task: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      }),
    /either --ticket or --task/,
  );
});

test('parseTaskPath maps task directories to run fields', () => {
  assert.deepEqual(parseTaskPath('/tmp/repo/projects/foo/tasks/fix/proj-2483-0409/TASK.md'), {
    project: 'foo',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-2483',
    relativePath: 'projects/foo/tasks/fix/proj-2483-0409/TASK.md',
  });
});

test('parseTaskPath uses generated task provenance over folder naming', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath reads the flow from handoff.json before the legacy provenance file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(path.join(taskDir, 'inputs/handoff.json'), JSON.stringify({ flow: 'fix-bug' }));
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );

  assert.equal(parseTaskPath(taskFile).flowType, 'fix-bug');
});

test('run create preserves the caller’s absolute task file path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.equal(buildRunCreateParams({ task: taskFile }).taskFile, taskFile);
});

test('run create resolves a relative task file against the caller working directory', (t) => {
  const caller = mkdtempSync(path.join(tmpdir(), 'farmslot-task-caller-'));
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(caller, { recursive: true, force: true });
  });
  const relative = 'projects/example/tasks/dev/PROJ-123/TASK.md';
  const absolute = path.join(caller, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, '# Caller task\n');
  process.chdir(caller);
  const params = buildRunCreateParams({ task: relative });
  assert.equal(params.taskFile, realpathSync(absolute));
  assert.equal(params.project, 'example');
});

test('parseTaskPath ignores unrelated parent directories named projects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-parent-projects-'));
  const taskDir = path.join(
    root,
    'projects',
    'farmslot',
    'projects/audiolab-farm/tasks/feat/414-0604-141246',
  );
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath ignores earlier parent projects tasks sequences', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-parent-projects-tasks-'));
  const taskDir = path.join(
    root,
    'projects',
    'parent',
    'tasks',
    'not-a-flow',
    'not-a-task',
    'projects/audiolab-farm/tasks/feat/414-0604-141246',
  );
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath uses generated Jira key metadata over folder naming', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/metamask-mobile/tasks/fix/3215-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ jiraKey: 'TAT-3215' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'metamask-mobile',
    flowType: 'fix-bug',
    ticketOrPr: 'TAT-3215',
    relativePath: 'projects/metamask-mobile/tasks/fix/3215-0604-141246/TASK.md',
  });
});

test('parseTaskPath reports malformed task metadata with file context', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(path.join(taskDir, 'inputs/template-provenance.json'), '{bad json');

  assert.throws(() => parseTaskPath(taskFile), /Invalid task metadata .*template-provenance\.json/);
});

test('run create builds scripted scenario config', () => {
  const params = buildRunCreateParams({
    project: 'farmslot-farm',
    flowType: 'dev',
    ticket: 'DEV-1',
    runner: 'scripted',
    scriptedScenario: 'success',
    scriptedStepDelayMs: '0',
  });

  assert.deepEqual(params.scripted, { mode: 'scenario', scenario: 'success', stepDelayMs: 0 });
});

test('run create rejects ambiguous scripted config', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'farmslot-farm',
        flowType: 'dev',
        ticket: 'DEV-1',
        runner: 'scripted',
        scriptedScenario: 'success',
        scriptedCommandRef: 'smoke',
      }),
    /either --scripted-scenario or --scripted-command-ref/,
  );
});

test('run create forwards the preview identity when pressure flags are given', () => {
  const params = buildRunCreateParams({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticket: 'PROJ-1',
    pressureMachine: 'macwork',
    pressureGeneration: 'macwork|gen-a|3|2026-08-21T09:59:30.000Z',
  });
  assert.deepEqual(params.pressureAdmissionRef, {
    machine: 'macwork',
    pressureGeneration: 'macwork|gen-a|3|2026-08-21T09:59:30.000Z',
  });
  assert.equal(params.pressureOverride, undefined);
});

test('run create builds a one-dispatch override when a reason is supplied', () => {
  const params = buildRunCreateParams({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticket: 'PROJ-1',
    pressureMachine: 'macwork',
    pressureGeneration: 'gen-x',
    pressureOverrideReason: 'urgent hotfix',
  });
  assert.deepEqual(params.pressureOverride, {
    machine: 'macwork',
    pressureGeneration: 'gen-x',
    reason: 'urgent hotfix',
  });
  assert.equal(params.pressureAdmissionRef, undefined);
});

test('run create refuses partial pressure flags', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'farmslot-farm',
        flowType: 'fix-bug',
        ticket: 'PROJ-1',
        pressureOverrideReason: 'urgent hotfix',
      }),
    /--pressure-machine and --pressure-generation/,
  );
});

test('run session prints the reopen and attach commands on their own lines', () => {
  const lines = formatRunSessionLines({
    supported: true,
    runId: 'run-1',
    role: 'fix-bug',
    contextId: 'fix-bug',
    runner: 'codex',
    model: 'gpt-5.6',
    sessionId: 'codex-session-123',
    sessionPath: '/repo/.agent/codex/sessions/codex-session-123.jsonl',
    capturedAt: '2026-09-04T09:00:00.000Z',
    slotId: 'macpro-mm-1',
    machine: 'macpro',
    tmuxTarget: 'mm-1:dev',
    interrupt: { command: '/exit', submitDelayMs: 50 },
    reopenCommand: "cd /repo && CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
    attachCommand: "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'",
    liveness: 'dead',
  });

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /codex\/gpt-5\.6/);
  assert.match(lines[0]!, /context=fix-bug/);
  assert.match(lines[0]!, /liveness=dead/);
  assert.equal(
    lines[1],
    "cd /repo && CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
  );
  assert.equal(lines[2], "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'");
});

test('run session reports an unsupported runner instead of printing a guessed command', () => {
  const lines = formatRunSessionLines({
    supported: false,
    runId: 'run-1',
    role: 'fix-bug',
    reason: 'session-reload-unsupported',
    detail: "Runner 'cursor' has no validated session reload.",
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /session-reload-unsupported/);
  assert.match(lines[1]!, /cursor/);
});

test('run get shows each step queue time, run time and last progress', () => {
  const run = {
    createdAt: '2026-10-07T10:02:10.000Z',
    queuedAt: '2026-10-07T10:00:00.000Z',
    steps: [
      // 2m10s in the dispatch queue before the run existed, then 3s finding a slot.
      { name: 'find-slot', status: 'done', durationMs: 3_000, queuedMs: 130_000 },
      {
        name: 'prepare',
        status: 'running',
        startedAt: '2026-10-07T10:02:13.000Z',
        lastProgressAt: '2026-10-07T10:06:45.000Z',
      },
      { name: 'dispatch', status: 'pending' },
    ],
  } as unknown as Run;

  assert.deepEqual(formatRunStepTimingLines(run, Date.parse('2026-10-07T10:07:25.000Z')), [
    'find-slot: queued 2m10s · ran 3s',
    'prepare: ran 5m12s · last progress 40s ago',
  ]);
});

test('run list clamps a blocked run reason so the table columns stay aligned', () => {
  const reason =
    'Step 6 recipe prerequisite cannot be met: the configured action catalog has no rendered ' +
    'order-book value/change timing observation to assert AC-3 refresh gaps <=500 ms.';
  const lines = formatRunListLines([
    { ...repeatReviewRun(), id: '4237202e-c2a6', status: 'blocked', error: reason },
    { ...repeatReviewRun(), id: '7721a02b-0000', status: 'monitoring' },
  ]);
  assert.equal(
    lines[0],
    '4237202e  Blocked: Step 6 recipe prerequisite can… review-pr    deeeed/farmslot#505',
  );
  assert.equal(lines[1], `7721a02b  ${'monitoring'.padEnd(40)} review-pr    deeeed/farmslot#505`);
});

test('parseAgentRole accepts a known role and rejects the rest', () => {
  assert.equal(parseAgentRole(undefined), undefined);
  assert.equal(parseAgentRole(''), undefined);
  assert.equal(parseAgentRole('review'), 'review');
  assert.throws(() => parseAgentRole('reviewer'), /Invalid --role 'reviewer'/);
  // A child checklist unit is observed, never spawned: it is not a session role.
  assert.throws(() => parseAgentRole('subtask'), /Invalid --role 'subtask'/);
});

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(packageDir, 'src', 'entry.ts');

function spawnRunCli(
  args: string[],
  home: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: packageDir,
      env: { ...process.env, FARMSLOT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI fixture timed out'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('run session --json forwards the exact context and returns the RPC result verbatim', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const payload = {
    supported: true,
    runId: 'run-1',
    role: 'review',
    contextId: 'rev2-codex',
    runner: 'codex',
    model: 'gpt-5.6',
    sessionId: 'reviewer-session-2',
    sessionPath: '/repo/.agent/codex/sessions/reviewer-session-2.jsonl',
    capturedAt: '2026-09-04T09:20:00.000Z',
    slotId: 'macpro-mm-1',
    machine: 'macpro',
    tmuxTarget: 'mm-1:rev2-codex',
    interrupt: { command: '/exit', submitDelayMs: 50 },
    reopenCommand: "CODEX_HOME=/repo/.agent/codex codex resume 'reviewer-session-2'",
    attachCommand: "tmux select-window -t 'mm-1:rev2-codex' \; attach -t '=mm-1'",
    liveness: 'live',
  };

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      if (request.method === 'auth.connect') {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: {} }));
        return;
      }
      calls.push({ method: request.method, params: request.params });
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-run-session-'));
  try {
    const result = await spawnRunCli(
      [
        '--url',
        url,
        '--timeout',
        '3000',
        '--json',
        'run',
        'session',
        'run-1',
        '--context',
        'rev2-codex',
        '--role',
        'review',
      ],
      home,
    );

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout) as { status: string; data: typeof payload };
    assert.equal(envelope.status, 'ok');
    assert.deepEqual(envelope.data, payload);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['run.sessionCommand'],
    );
    // The exact context must reach the gateway; role alone would resolve to
    // whichever reviewer is newest.
    assert.equal(calls[0]!.params.contextId, 'rev2-codex');
    assert.equal(calls[0]!.params.role, 'review');
    assert.equal(calls[0]!.params.runId, 'run-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
    server.close();
  }
});

test('static review flags preserve machine, native runner and effort while refusing mixed placement', () => {
  const base = { project: 'review', flowType: 'review-pr', ticket: 'owner/repo#42' };
  const params = buildRunCreateParams({
    ...base,
    reviewMachine: 'node',
    transport: 'native',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
  });
  assert.deepEqual(params.reviewWorkspaceTarget, { machine: 'node' });
  assert.equal(params.transport, 'native');
  assert.equal(params.effort, 'high');
  assert.equal('reviewValidationDepth' in params, false, 'new CLI reviews never submit a depth');
  assert.throws(
    () => buildRunCreateParams({ ...base, reviewMachine: 'node', slot: 'runtime' }),
    /--review-machine cannot be combined with --slot/,
  );
});

test('review mode and sequence preserve every selection dimension through CLI dispatch', () => {
  const selection = { runner: 'codex', model: 'gpt-6-astra', effort: 'xhigh', mode: 'warm' };
  const context = {
    reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'review-1' }],
  };
  const params = buildRunCreateParams({
    project: 'review',
    flowType: 'review-pr',
    ticket: 'owner/repo#42',
    reviewMode: 'warm',
    reviewSequence: JSON.stringify([selection]),
    reviewContext: JSON.stringify(context),
    reviewSequenceContext: JSON.stringify(context),
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'xhigh',
  });
  assert.equal(params.reviewMode, 'warm');
  assert.deepEqual(params.reviewSequence, [selection]);
  assert.deepEqual(params.reviewContext, context);
  assert.deepEqual(params.reviewSequenceContext, context);
  for (const mode of ['incremental', 'full', 'resume', 'reset'])
    assert.throws(
      () => buildRunCreateParams({ project: 'review', ticket: 'owner/repo#42', reviewMode: mode }),
      /warm or cold/,
    );
  assert.throws(
    () => buildRunCreateParams({ project: 'review', ticket: 'owner/repo#42', reviewSequence: '{' }),
    /valid JSON array/,
  );
  assert.throws(
    () => buildRunCreateParams({ project: 'review', ticket: 'owner/repo#42', reviewContext: '{' }),
    /valid JSON/,
  );
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'review',
        ticket: 'owner/repo#42',
        reviewContext: JSON.stringify({ reviewLineages: [{ runner: 'codex' }] }),
      }),
    /unsupported property/,
  );
});

test('QA CLI flags preserve opaque nested skill inputs and require the explicit QA flow', () => {
  const inputs = {
    scope: { since: '2026-09-14T00:00:00Z' },
    recipes: ['login', 'account'],
    smoke: true,
    limit: 3,
    optional: null,
  };
  const base = { project: 'example-farm', flowType: 'qa', ticket: 'changes-in-window' };
  const params = buildRunCreateParams({
    ...base,
    qaProfile: 'daily-check',
    qaInputs: JSON.stringify(inputs),
    slot: 'runtime-1',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    transport: 'native',
  });
  assert.equal(params.qaProfileId, 'daily-check');
  assert.deepEqual(params.qaInputs, inputs);
  assert.equal(params.flowType, 'qa');
  assert.equal(params.slotId, 'runtime-1');
  assert.equal(params.effort, 'high');
  assert.equal(params.transport, 'native');
  assert.equal('sessionIntent' in params, false);
  assert.equal('scope' in params, false);
  assert.equal('qaProfileId' in buildRunCreateParams(base), false);
  assert.equal('qaInputs' in buildRunCreateParams(base), false);
  assert.deepEqual(buildRunCreateParams({ ...base, qaInputs: '{}' }).qaInputs, {});
  for (const flowType of ['review-pr', 'dev', undefined]) {
    for (const qa of [{ qaProfile: 'daily-check' }, { qaInputs: '{}' }]) {
      assert.throws(
        () => buildRunCreateParams({ ...base, flowType, ...qa }),
        /require explicit --flow-type qa/,
      );
    }
  }
  assert.throws(() => buildRunCreateParams({ ...base, qaProfile: ' ' }), /QA preset id/);
  assert.throws(
    () => buildRunCreateParams({ ...base, reviewMachine: 'static-machine' }),
    /QA uses a runtime slot/,
  );
});

test('QA CLI rejects malformed JSON, non-object roots and unrepresentable JSON numbers', () => {
  const base = { project: 'example-farm', flowType: 'qa', ticket: 'changes-in-window' };
  for (const qaInputs of ['{', '', '{"nested":{"value":1e999}}']) {
    assert.throws(
      () => buildRunCreateParams({ ...base, qaInputs }),
      /--qa-inputs must be a valid JSON object/,
    );
  }
  for (const qaInputs of ['null', '[]', '"text"', '1', 'false']) {
    assert.throws(() => buildRunCreateParams({ ...base, qaInputs }), /QA inputs.*object/);
  }
});

test('run create and dispatch preview register QA flags and forward only typed QA fields', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data));
      if (request.method !== 'auth.connect')
        calls.push({ method: request.method, params: request.params });
      socket.send(
        JSON.stringify({
          type: 'res',
          id: request.id,
          ok: true,
          payload:
            request.method === 'auth.connect'
              ? {}
              : { run: { id: 'qa-cli-run' }, preview: { flowType: 'qa' } },
        }),
      );
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-qa-cli-'));
  const inputs = {
    scope: { from: 'release-base', to: 'release-head' },
    recipes: ['smoke'],
    enabled: true,
  };
  try {
    for (const command of [
      ['run', 'create'],
      ['dispatch', 'preview'],
    ]) {
      const result = await spawnRunCli(
        [
          '--url',
          url,
          '--timeout',
          '3000',
          '--json',
          ...command,
          '--project',
          'example-farm',
          '--flow-type',
          'qa',
          '--ticket',
          'change-range',
          '--qa-profile',
          'release-check',
          '--qa-inputs',
          JSON.stringify(inputs),
          '--slot',
          'runtime-1',
          '--runner',
          'codex',
          '--model',
          'gpt-6-astra',
          '--effort',
          'high',
          '--transport',
          'native',
        ],
        home,
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const params = calls.at(-1)!.params;
      assert.equal(params.flowType, 'qa');
      assert.equal(params.qaProfileId, 'release-check');
      assert.deepEqual(params.qaInputs, inputs);
      assert.equal(params.slotId, 'runtime-1');
      assert.equal(params.runner, 'codex');
      assert.equal(params.model, 'gpt-6-astra');
      assert.equal(params.effort, 'high');
      assert.equal(params.transport, 'native');
      assert.equal('sessionIntent' in params, false);
      assert.equal('scope' in params, false);
    }
    assert.deepEqual(
      calls.map((call) => call.method),
      ['run.createNative', 'dispatch.preview'],
    );
    for (const command of [
      ['run', 'create'],
      ['dispatch', 'preview'],
    ]) {
      const before = calls.length;
      const invalid = await spawnRunCli(
        [
          '--url',
          url,
          '--timeout',
          '3000',
          '--json',
          ...command,
          '--project',
          'example-farm',
          '--flow-type',
          'qa',
          '--ticket',
          'change-range',
          '--qa-inputs',
          '[1,2]',
        ],
        home,
      );
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stdout + invalid.stderr, /QA inputs.*object/);
      assert.equal(calls.length, before, 'invalid inputs must not reach the create/preview RPC');
    }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(home, { recursive: true, force: true });
  }
});

test('direct publication flags preserve unset, explicit true and explicit false values', () => {
  const base = {
    project: 'farm',
    flowType: 'review-pr',
    ticket: 'example/app#42',
    reviewMachine: 'machine',
    runner: 'codex',
    model: 'gpt-6-luna',
  };
  assert.equal(buildRunCreateParams(base).publishReview, undefined);
  assert.equal(
    buildRunCreateParams({ ...base, publishReview: true, reviewTeam: 'team' }).publishReview,
    true,
  );
  assert.equal(buildRunCreateParams({ ...base, publishReview: false }).publishReview, false);
  assert.equal(buildRunCreateParams({ ...base, reviewTeam: 'team' }).reviewTeamId, 'team');
});

test('gate CLI shows a held result decision and sends its written reason', () => {
  const payload: ResultDecisionPayload = {
    kind: 'result-decision',
    stoppedAt: 'review',
    reason: 'Review found 2 issue(s) after 1/2 fix attempts',
    findings: [
      {
        file: 'src/features/perpetuals/queries/invalidate-live-trading-queries.ts',
        line: 31,
        description: 'No test covers the marginModeLock invalidation.',
      },
    ],
    delivered: {
      headSha: '3522954d1f0b7c1f2a6c0f9d6b1e0c5a7e2d9f10',
      branch: 'feat/tat-4145-opus',
    },
    findingsDigest: 'sha256:x',
    actions: [
      {
        id: 'send-back',
        available: false,
        unavailableReason: 'All 5 review rounds for this work are spent.',
        requiresReason: false,
      },
      { id: 'accept-result', available: true, requiresReason: true },
      { id: 'close-result', available: true, requiresReason: false },
    ],
  };
  assert.deepEqual(formatResultDecision(payload), [
    '  Review found 2 issue(s) after 1/2 fix attempts',
    '  src/features/perpetuals/queries/invalidate-live-trading-queries.ts:31  No test covers the marginModeLock invalidation.',
    '  Delivered feat/tat-4145-opus @ 3522954d1f0b',
    '  - send-back  (unavailable: All 5 review rounds for this work are spent.)',
    '  - accept-result  --reason required',
    '  - close-result',
  ]);
  const decision: RunDecision = {
    id: 'result',
    type: 'engine_result_decision',
    title: 'TAT-4145 — result needs a decision',
    description: payload.reason,
    actions: payload.actions.map((action) => ({
      id: action.id,
      label: action.id,
      style: 'secondary',
    })),
    createdAt: '2026-10-18T11:00:00.000Z',
    payload,
  };
  assert.throws(
    () => assertRunGateActionAvailable(decision, 'send-back'),
    /unavailable: All 5 review rounds/,
  );
  const params = buildRunGateParams({ id: 'run' } as Run, decision, 'accept-result', {
    reason: ' Coverage only. ',
  });
  assert.equal(params.reason, 'Coverage only.');
  assert.equal(params.evidenceAttestationReason, undefined);
});

test('combined gate CLI needs explicit evidence consent and carries both receipt reason fields', () => {
  const run = repeatReviewRun();
  const decision: RunDecision = {
    id: 'gate-combined',
    type: 'engine_human_gate',
    title: 'Publish',
    description: 'Combined consent',
    createdAt: new Date().toISOString(),
    actions: [],
    payload: {
      kind: 'ready',
      branch: 'branch',
      repo: null,
      prNumber: null,
      workerReport: '',
      diffStat: { files: 0, additions: 0, deletions: 0 },
      gateReadiness: {
        state: 'not-ready',
        identity: { runId: run.id, generation: 1 },
        reasons: [
          {
            code: 'review-fix-required',
            prerequisite: 'review',
            message: 'Open finding',
            allowedReviewOverrides: [APPROVE_PUBLISH_UNRESOLVED_ACTION],
          },
          {
            code: 'evidence-policy-unsatisfied',
            prerequisite: 'evidence',
            evidencePolicy: 'claim-verdict',
            message: 'Missing production-state proof',
          },
        ],
        findings: [
          {
            reviewId: 'review',
            file: 'evidence-manifest.json',
            description: 'Missing production-state proof',
          },
        ],
        findingsDigest: 'sha256:combined',
      },
    },
  };
  assert.throws(
    () =>
      buildRunGateParams(run, decision, APPROVE_PUBLISH_UNRESOLVED_ACTION, {
        reason: 'Accept only.',
      }),
    /explicit --attest-evidence/,
  );
  const params = buildRunGateParams(run, decision, APPROVE_PUBLISH_UNRESOLVED_ACTION, {
    reason: ' I accept and attest. ',
    attestEvidence: true,
  });
  assert.equal(params.reason, 'I accept and attest.');
  assert.equal(params.evidenceAttestationReason, 'I accept and attest.');
  assert.equal(params.findingsDigest, 'sha256:combined');
  const program = new Command();
  registerRunCommand(program);
  assert.ok(
    program.commands
      .find((c) => c.name() === 'run')!
      .commands.find((c) => c.name() === 'gate')!
      .options.some((o) => o.long === '--attest-evidence'),
  );
});
