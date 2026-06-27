import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';
import type { ObservabilityReading, RunnerActivity } from './observability-types.js';
import { makeVars } from './test-fixtures.js';

const vars = makeVars();
const target = 'test-1:dev';
const message = 'Read and execute TASK.md in /tmp/repo/tasks/foo';

let activityReading: ObservabilityReading<RunnerActivity> | null = {
  value: 'idle',
  source: 'hook',
  confidence: 'high',
  observedAt: Date.now(),
};
let promptAcceptedReading: ObservabilityReading<boolean> | null = {
  value: true,
  source: 'hook',
  confidence: 'high',
  observedAt: Date.now(),
};

const callOrder: string[] = [];
let paneText = '❯\nctx:12%\n';

mock.module('./claude-observability.js', {
  namedExports: {
    claudeHookObservability: {
      async getActivity() {
        callOrder.push('obs:getActivity');
        return activityReading;
      },
      async getContextPct() {
        return null;
      },
      async activeTool() {
        return null;
      },
      async lastTurnCompletedAt() {
        return null;
      },
      async promptAccepted() {
        callOrder.push('obs:promptAccepted');
        return promptAcceptedReading;
      },
    },
  },
});

mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => true,
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_slotVars: SlotVars, cmd: string) => {
      if (cmd.includes('capture-pane')) {
        callOrder.push('pane:capture');
        return { exitCode: 0, stdout: paneText, stderr: '' };
      }
      if (cmd.includes('send-keys') || cmd.includes('send-text')) {
        callOrder.push('tmux:send');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('python3 -')) {
        callOrder.push('sentinel:write');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('hooks.jsonl') || cmd.includes('stat -')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});

const { sendRunnerInstructionSafely } = await import('./registry.js');

test('sendRunnerInstructionSafely consults observability before pane on hook-authoritative idle', async () => {
  callOrder.length = 0;
  activityReading = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n';

  const sent = await sendRunnerInstructionSafely(
    vars,
    target,
    'claude',
    message,
    '[test]',
    10_000,
    { forceBusyPoll: true },
  );

  assert.equal(sent, true);
  const obsPromptIdx = callOrder.indexOf('obs:promptAccepted');
  const obsActivityIdx = callOrder.indexOf('obs:getActivity');
  const firstPaneIdx = callOrder.indexOf('pane:capture');
  assert.ok(obsPromptIdx >= 0, `expected obs:promptAccepted in ${callOrder.join(',')}`);
  assert.ok(obsActivityIdx >= 0, `expected obs:getActivity in ${callOrder.join(',')}`);
  assert.ok(
    obsPromptIdx < firstPaneIdx || firstPaneIdx === -1,
    `obs promptAccepted should precede first pane capture; order=${callOrder.join(',')}`,
  );
  assert.ok(
    obsActivityIdx < firstPaneIdx,
    `obs getActivity should precede first pane capture; order=${callOrder.join(',')}`,
  );
});

test('sendRunnerInstructionSafely skips pane busy scrape when hook reports composing', async () => {
  callOrder.length = 0;
  activityReading = {
    value: 'composing',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const sent = await sendRunnerInstructionSafely(
    vars,
    target,
    'codex',
    message,
    '[test]',
    50,
    { forceBusyPoll: true },
  );

  assert.equal(sent, false);
  assert.ok(callOrder.includes('obs:promptAccepted'));
  assert.ok(callOrder.includes('obs:getActivity'));
  const obsActivityIdx = callOrder.indexOf('obs:getActivity');
  const firstPaneIdx = callOrder.indexOf('pane:capture');
  assert.ok(
    firstPaneIdx === -1 || obsActivityIdx < firstPaneIdx,
    `busy decision must consult hooks before any pane capture; order=${callOrder.join(',')}`,
  );
});

test('sendRunnerInstructionSafely falls back to pane when hook activity is unknown', async () => {
  callOrder.length = 0;
  activityReading = {
    value: 'unknown',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  promptAcceptedReading = {
    value: true,
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  paneText = '❯\nctx:12%\n';

  const sent = await sendRunnerInstructionSafely(
    vars,
    target,
    'claude',
    message,
    '[test]',
    10_000,
    { forceBusyPoll: true },
  );

  assert.equal(sent, true);
  assert.ok(callOrder.includes('pane:capture'));
  const obsActivityIdx = callOrder.indexOf('obs:getActivity');
  const firstPaneIdx = callOrder.indexOf('pane:capture');
  assert.ok(obsActivityIdx < firstPaneIdx);
});