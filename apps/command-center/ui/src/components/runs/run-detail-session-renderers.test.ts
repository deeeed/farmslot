import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, Run, RunSessionCommandResult } from '@farmslot/protocol';

import {
  livenessLabel,
  runAgentSessionRows,
  runnerSessionOpenRefusal,
  runSessionCommandTextForKind,
  runSessionCopyButtonLabel,
  runSessionCopyButtonState,
  runSessionLocationLabel,
  runSessionOpenButtonLabel,
  runSessionPasteOnLabel,
  runSessionRowStateFromResult,
  shouldRestoreRunnerSessionOnHost,
} from './run-detail-session-renderers.js';

function run(contexts: AgentContext[]): Pick<Run, 'agentContexts' | 'metrics'> {
  return {
    agentContexts: contexts,
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.6' },
  };
}

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Worker',
    status: 'working',
    slotId: 'macpro-mm-1',
    runId: 'run-1',
    runner: 'codex',
    model: 'gpt-5.6',
    runnerSessionId: 'codex-session-123',
    runnerSessionPath: '/repo/.agent/codex/sessions/codex-session-123.jsonl',
    target: { session: 'mm-1', window: 'dev', pane: null, target: 'mm-1:dev' },
    ...overrides,
  };
}

const supported: RunSessionCommandResult = {
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
  reopenCommand: "CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
  attachCommand: "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'",
  liveness: 'dead',
};

test('run detail lists one session row per agent context with a short session id', () => {
  const rows = runAgentSessionRows(
    run([
      context(),
      context({
        id: 'self-review',
        role: 'self-review',
        label: 'Reviewer',
        runner: 'claude',
        model: 'sonnet',
        runnerSessionId: null,
        runnerSessionPath: null,
      }),
    ]),
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.role, 'fix-bug');
  assert.equal(rows[0]?.runner, 'codex');
  assert.equal(rows[0]?.model, 'gpt-5.6');
  assert.equal(rows[0]?.sessionIdShort, 'codex-se');
  assert.equal(rows[0]?.slotId, 'macpro-mm-1');
  assert.equal(rows[0]?.target, 'mm-1:dev');
  assert.equal(rows[1]?.role, 'self-review');
  assert.equal(rows[1]?.runner, 'claude');
  assert.equal(rows[1]?.sessionIdShort, null);
});

test('the row names the slot and tmux target before any copy', () => {
  const row = runAgentSessionRows(run([context()]))[0];
  assert.equal(runSessionLocationLabel(row!), 'macpro-mm-1 · mm-1:dev');
  assert.equal(
    runSessionLocationLabel({
      slotId: 'runner-local-mobile-1',
      target: 'runner-local-mobile-1:dev',
    }),
    'runner-local-mobile-1:dev',
  );
  assert.equal(runSessionLocationLabel({ slotId: null, target: null }), null);
});

test('copy buttons are labeled as copy, not as execute', () => {
  assert.equal(runSessionCopyButtonLabel(undefined, 'reopen'), 'Copy reopen');
  assert.equal(runSessionCopyButtonLabel(undefined, 'attach'), 'Copy attach');
  assert.equal(runSessionCopyButtonLabel({ status: 'loading' }, 'reopen'), 'Copying…');
  assert.equal(
    runSessionCopyButtonLabel({ status: 'ready', copied: 'reopen' }, 'reopen'),
    'Copied',
  );
  assert.equal(
    runSessionCopyButtonLabel({ status: 'ready', copied: 'reopen' }, 'attach'),
    'Copy attach',
  );
  assert.equal(runSessionCopyButtonState(undefined, 'reopen'), 'idle');
  assert.equal(runSessionCopyButtonState({ status: 'loading' }, 'attach'), 'loading');
  assert.equal(
    runSessionCopyButtonState({ status: 'ready', copied: 'attach' }, 'attach'),
    'copied',
  );
  assert.equal(runSessionOpenButtonLabel(undefined), 'Open on host');
  assert.equal(runSessionOpenButtonLabel({ status: 'opening' }), 'Opening…');
});

test('Open on host reloads a dead pane only while the run is still live', () => {
  assert.equal(
    shouldRestoreRunnerSessionOnHost({ liveness: 'live', runStatus: 'monitoring' }),
    false,
  );
  assert.equal(
    shouldRestoreRunnerSessionOnHost({ liveness: 'dead', runStatus: 'monitoring' }),
    true,
  );
  assert.equal(shouldRestoreRunnerSessionOnHost({ liveness: 'dead', runStatus: 'done' }), false);
});

test('Open on host refuses transferred or unproved slot ownership', () => {
  assert.equal(runnerSessionOpenRefusal({ ...supported, ownership: 'owned' }), null);
  assert.match(
    runnerSessionOpenRefusal({
      ...supported,
      ownership: 'transferred',
      ownerRunId: 'run-successor',
    }) ?? '',
    /run-successor/,
  );
  assert.match(runnerSessionOpenRefusal({ ...supported, ownership: 'unknown' }) ?? '', /unknown/);
  assert.match(runnerSessionOpenRefusal(supported) ?? '', /unknown/);
});

test('switching runs clears the bound terminal context so the next run cannot inherit it', () => {
  const detail = readFileSync(path.resolve(import.meta.dirname, 'run-detail.ts'), 'utf8');
  assert.match(detail, /this\._terminalContextId = '';/);
  assert.match(detail, /this\._terminalRole = '';/);
  assert.match(detail, /this\.runId !== this\._lastRequestedRunId/);
});

test('copy buttons use only the command the gateway built', () => {
  assert.equal(
    runSessionCommandTextForKind(supported, 'reopen'),
    "CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
  );
  assert.equal(
    runSessionCommandTextForKind(supported, 'attach'),
    "tmux select-window -t 'mm-1:dev' \\; attach -t '=mm-1'",
  );
});

test('row state carries the structured liveness the gateway proved', () => {
  const state = runSessionRowStateFromResult(supported, 'reopen');
  assert.deepEqual(state, {
    status: 'ready',
    liveness: 'dead',
    copied: 'reopen',
    command: "CODEX_HOME=/repo/.agent/codex codex resume 'codex-session-123'",
    machine: 'macpro',
    slotId: 'macpro-mm-1',
    tmuxTarget: 'mm-1:dev',
  });
  assert.equal(livenessLabel('dead'), 'interrupted');
  assert.equal(livenessLabel('live'), 'live');
  assert.equal(livenessLabel('unknown'), 'liveness unknown');
  assert.equal(runSessionPasteOnLabel(state), 'Paste on macpro · macpro-mm-1 · mm-1:dev');
});

test('an unsupported runner surfaces its reason and copies nothing', () => {
  const result: RunSessionCommandResult = {
    supported: false,
    runId: 'run-1',
    role: 'fix-bug',
    reason: 'session-reload-unsupported',
    detail: "Runner 'cursor' has no validated session reload.",
  };

  assert.equal(runSessionCommandTextForKind(result, 'reopen'), null);
  assert.deepEqual(runSessionRowStateFromResult(result, 'reopen'), {
    status: 'error',
    message: "Runner 'cursor' has no validated session reload.",
  });
});

test('a missing attach command is an error state, never a silent no-op copy', () => {
  const state = runSessionRowStateFromResult({ ...supported, attachCommand: null }, 'attach');
  assert.equal(state.status, 'error');
  assert.equal(state.liveness, 'dead');
  assert.match(state.message ?? '', /attach command/);
});

test('a refused clipboard keeps the proved liveness and never reports Copied', () => {
  const state = runSessionRowStateFromResult(supported, 'reopen', 'Clipboard copy failed: denied');

  assert.equal(state.status, 'error');
  assert.equal(state.liveness, 'dead');
  assert.equal(state.copied, undefined);
  // A discrete flag, so no caller has to pattern-match the message text.
  assert.equal(state.copyBlocked, true);
  assert.equal(state.message, 'Clipboard copy failed: denied');
  // The command stays visible so the operator can copy it by hand.
  assert.equal(state.command, supported.reopenCommand);
  assert.equal(runSessionPasteOnLabel(state), 'Paste on macpro · macpro-mm-1 · mm-1:dev');
  assert.equal(runSessionCopyButtonLabel(state, 'reopen'), 'Copy reopen');
});

test('a gateway-side failure is not marked as a blocked copy', () => {
  const unsupportedResult: RunSessionCommandResult = {
    supported: false,
    runId: 'run-1',
    role: 'fix-bug',
    reason: 'session-not-captured',
    detail: 'No runner session was captured.',
  };

  assert.equal(runSessionRowStateFromResult(unsupportedResult, 'reopen').copyBlocked, undefined);
  assert.equal(runSessionRowStateFromResult(supported, 'reopen').copyBlocked, undefined);
});

test('two same-role reviewer rows stay distinct so each copies its own session', () => {
  const rows = runAgentSessionRows(
    run([
      context({
        id: 'rev-codex',
        role: 'self-review',
        label: 'Reviewer 1',
        runnerSessionId: 'reviewer-session-1',
      }),
      context({
        id: 'rev2-codex',
        role: 'self-review',
        label: 'Reviewer 2',
        runnerSessionId: 'reviewer-session-2',
      }),
    ]),
  );

  assert.equal(rows.length, 2);
  // Rows are addressed by contextId: role-keyed identity made both reviewers
  // resolve to whichever context was newest.
  assert.equal(rows[0]?.contextId, 'rev-codex');
  assert.equal(rows[1]?.contextId, 'rev2-codex');
  assert.notEqual(rows[0]?.contextId, rows[1]?.contextId);
  assert.equal(rows[0]?.sessionIdShort, 'reviewer');
  assert.equal(rows[0]?.role, rows[1]?.role);
});

test('the request guard is keyed per context so one row cannot strand another', () => {
  // A single global counter meant clicking a second row invalidated the first
  // row's in-flight request, leaving it on "Loading…" with no way back.
  const detail = readFileSync(path.resolve(import.meta.dirname, 'run-detail.ts'), 'utf8');
  const family = readFileSync(path.resolve(import.meta.dirname, 'family-observability.ts'), 'utf8');

  for (const source of [detail, family]) {
    assert.match(source, /this\._sessionRequestSeq\[row\.contextId\]/);
    assert.match(source, /requestSeq === this\._sessionRequestSeq\[row\.contextId\]/);
    assert.doesNotMatch(source, /\+\+this\._sessionRequestSeq;/);
  }
});

test('slot-free native review rows do not fall back to tmux controls', () => {
  const rows = runAgentSessionRows(
    run([
      context({
        id: 'review',
        role: 'review',
        slotId: null,
        nativeSession: {
          sessionId: 'native-review',
          leaseId: 'lease',
          commandId: 'command',
          executionNodeId: 'local',
          ownerPrincipalId: 'owner',
        },
      }),
    ]),
  );
  assert.equal(rows[0].workspaceView, true);
  assert.equal(rows[0].nativeHref, undefined);
});
