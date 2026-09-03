// @farmslot:serial — creates and removes real template dirs under the shared repo `projects/`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { farmslotRoot } from '../core/config.js';
import { makeRun } from '../run-engine/test-fixtures.js';

import {
  resolveCiFixReplacementOwner,
  resolveCiFixRetainedSession,
  resolveCiFixTemplatePath,
  resolveRecoverableCiFixContext,
  sendCiFixNudge,
} from './inline-fix.js';

test('CI fix recovery requires a durable prompt boundary and HEAD baseline', () => {
  const context = {
    id: 'ci-fix',
    label: 'CI fix',
    role: 'ci-fix' as const,
    status: 'launching' as const,
    runner: 'cursor',
    slotId: 'macpro-mm-5',
    runId: 'run-1',
    taskFile: 'tasks/run-1/CI-FIX.md',
    signalFile: 'tasks/run-1/CI-FIX-SIGNAL.json',
    promptDeliveryStartedAt: '2026-08-25T09:00:00.000Z',
    deliveryBaselineRef: 'abc1234',
    deliveryBaselinePanePid: '1234',
    target: { session: 'mm-5', window: 'dev', pane: null, target: 'mm-5:dev' },
  };
  const run = { ...makeRun({ flowType: 'dev' }), agentContexts: [context] };

  assert.equal(resolveRecoverableCiFixContext(run)?.id, 'ci-fix');
  assert.equal(
    resolveRecoverableCiFixContext({
      ...run,
      agentContexts: [{ ...context, promptDeliveryStartedAt: undefined }],
    }),
    null,
  );

  const codexContext = {
    ...context,
    runner: 'codex',
    status: 'working' as const,
  };
  assert.equal(
    resolveRecoverableCiFixContext({ ...run, agentContexts: [codexContext] })?.id,
    'ci-fix',
  );
  assert.equal(
    resolveRecoverableCiFixContext({
      ...run,
      agentContexts: [{ ...codexContext, status: 'launching' }],
    }),
    null,
    'an in-place runner is recoverable only after its prompt was accepted',
  );
});

test('CI fix replacement readiness excludes the pending CI context', () => {
  const run: Run = {
    ...makeRun({ flowType: 'dev' }),
    agentContexts: [
      {
        id: 'dev',
        label: 'Dev',
        role: 'dev',
        status: 'working',
        slotId: 'macpro-mm-5',
        runId: 'run-1',
        signalFile: 'tasks/run-1/SIGNAL.json',
        target: { session: 'mm-5', window: 'dev', pane: '%10', target: 'mm-5:dev' },
      },
      {
        id: 'ci-fix',
        label: 'CI fix',
        role: 'ci-fix',
        status: 'working',
        slotId: 'macpro-mm-5',
        runId: 'run-1',
        signalFile: 'tasks/run-1/CI-FIX-SIGNAL.json',
        signalAttemptId: 'ci-attempt-2',
        target: { session: 'mm-5', window: 'dev', pane: '%10', target: 'mm-5:dev' },
      },
    ],
  };

  assert.equal(resolveCiFixReplacementOwner(run, 'mm-5:dev')?.id, 'dev');
});

test('CI fix replacement readiness fails closed for ambiguous follow-up ownership', () => {
  const run: Run = {
    ...makeRun({ flowType: 'dev' }),
    agentContexts: ['review', 'self-review-fix'].map((role) => ({
      id: role,
      label: role,
      role: role as 'review' | 'self-review-fix',
      status: 'working' as const,
      slotId: 'macpro-mm-5',
      runId: 'run-1',
      signalFile: `tasks/run-1/${role}-SIGNAL.json`,
      target: { session: 'mm-5', window: 'dev', pane: '%10', target: 'mm-5:dev' },
    })),
  };

  assert.equal(resolveCiFixReplacementOwner(run, 'mm-5:dev'), null);
});

test('CI fix delivery resolves the primary worker retained session', () => {
  const retained = resolveCiFixRetainedSession(
    makeRun({
      flowType: 'dev',
      metrics: {
        nudgeCount: 0,
        runner: 'codex',
        model: 'gpt-5.6-sol',
        runnerSessionId: 'session-1',
        runnerSessionPath: '/sessions/session-1.jsonl',
      },
    }),
  );

  assert.deepEqual(retained, {
    binding: {
      runnerSessionId: 'session-1',
      runnerSessionPath: '/sessions/session-1.jsonl',
    },
    reason: null,
  });
});

test('CI fix delivery flags a half-persisted retained session as unresolvable', () => {
  const retained = resolveCiFixRetainedSession(
    makeRun({
      flowType: 'dev',
      metrics: {
        nudgeCount: 0,
        runner: 'codex',
        model: 'gpt-5.6-sol',
        runnerSessionId: 'session-1',
        runnerSessionPath: null,
      },
    }),
  );

  assert.equal(retained.binding, null);
  assert.equal(retained.incompleteBinding, true);
});

test('CI fix nudge fails closed only on an incomplete retained binding', async () => {
  const run = makeRun({
    flowType: 'dev',
    metrics: {
      nudgeCount: 0,
      runner: 'codex',
      model: 'gpt-5.6-sol',
      runnerSessionId: 'session-1',
      runnerSessionPath: null,
    },
  });

  // Returns before any slot I/O, so no runner/tmux fixtures are needed. A run
  // with no retained facts at all takes the fresh-delivery path instead, which
  // requires a live slot and is proved by the live CI-fix scenario.
  const result = await sendCiFixNudge({
    vars: null as never,
    target: 'session:0.0',
    runner: 'codex',
    prompt: 'fix CI',
    run,
  });

  assert.equal(result.sent, false);
  assert.equal(result.retainedSession.incompleteBinding, true);
});

test('resolveCiFixTemplatePath prefers project-owned ci-fix.md', async () => {
  const project = `ci-fix-test-${Date.now()}`;
  const projectDir = path.join(farmslotRoot, 'projects', project, 'templates', 'worker');
  await mkdir(projectDir, { recursive: true });
  const projectTemplate = path.join(projectDir, 'ci-fix.md');
  await writeFile(projectTemplate, '# test\n', 'utf-8');
  try {
    const resolved = await resolveCiFixTemplatePath(project);
    assert.equal(resolved, projectTemplate);
  } finally {
    await rm(path.join(farmslotRoot, 'projects', project), { recursive: true, force: true });
  }
});

test('resolveCiFixTemplatePath falls back to Farmslot default template', async () => {
  const resolved = await resolveCiFixTemplatePath('__missing-project-for-ci-fix-test__');
  assert.equal(resolved, path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md'));
});

test('default CI fix template uses explicit CI-FIX marker targeting', async () => {
  const template = await readFile(
    path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md'),
    'utf-8',
  );

  assert.match(template, /mark --checklist CI-FIX\.md start/);
  assert.match(template, /mark --checklist CI-FIX\.md 1/);
  assert.match(template, /mark --checklist CI-FIX\.md complete --mark-last/);
  assert.doesNotMatch(template, /mark start/);
  assert.doesNotMatch(template, /mark complete \|/);
  assert.doesNotMatch(template, /mark-checklist-step\.cjs .*CI-FIX\.md .*CI-FIX-SIGNAL\.json/);
});

test('default CI fix template completion marker writes CI-FIX signal', async () => {
  const templatePath = path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md');
  const template = await readFile(templatePath, 'utf-8');
  const taskDir = await mkdtemp(path.join(tmpdir(), 'farmslot-ci-fix-mark-'));
  const marker = path.join(
    farmslotRoot,
    'packages',
    'agent-runtime',
    'scripts',
    'mark-checklist-step.cjs',
  );

  try {
    await writeFile(path.join(taskDir, 'CI-FIX.md'), template, 'utf-8');
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    await writeFile(path.join(taskDir, 'artifacts', 'report.md'), '# CI fix report\n', 'utf-8');
    await writeFile(
      path.join(taskDir, 'artifacts', 'learnings.md'),
      '- Regression covered.\n',
      'utf-8',
    );

    const runMarker = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [marker, taskDir, '--checklist', 'CI-FIX.md', ...args],
        {
          encoding: 'utf-8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
    };

    runMarker('start');
    const checklistItemCount = template.match(/^\s*-\s+\[ \]/gm)?.length ?? 0;
    assert.ok(checklistItemCount > 0, 'expected CI-FIX.md checklist items');
    for (let step = 1; step <= checklistItemCount; step += 1) {
      runMarker(String(step));
    }
    runMarker('complete', '--mark-last');

    const signal = JSON.parse(await readFile(path.join(taskDir, 'CI-FIX-SIGNAL.json'), 'utf-8'));
    assert.equal(signal.status, 'complete');
    assert.equal(signal.outcome, 'success');
    assert.equal(signal.checklistTiming.source, 'CI-FIX.md');
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});
