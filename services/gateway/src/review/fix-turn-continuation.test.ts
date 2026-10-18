import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

const core = await import('../core/exec.js');

const MINUTE = 60_000;
const session = '01a14d96-c35d-7cb3-8849-e5bc94b1638d';
const acceptedToken = `${session}:1792314858624`;
const deliveryStartedAt = '2026-10-18T09:14:15.302Z';

type Turn = { from: number; to: number; token: string };
let turns: Turn[] = [];
let signal: { at: number; raw: string } | null = null;
let current: Run | undefined;
const baseline = JSON.stringify({
  attemptId: 'attempt-1',
  step: '2. Read full feedback',
  status: 'running',
});

mock.module('../core/exec.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_vars: unknown, command: string) => {
      // The grok process runs under the pane's shell (pid 4242).
      if (command.includes('display-message')) return { exitCode: 0, stdout: 'zsh\n', stderr: '' };
      if (command.includes('list-panes')) return { exitCode: 0, stdout: '4242\n', stderr: '' };
      if (command.includes('4242')) return { exitCode: 0, stdout: '4243\n', stderr: '' };
      if (command.includes('REVIEW-FIX-SIGNAL.json')) {
        const raw = signal && Date.now() >= signal.at ? signal.raw : baseline;
        return { exitCode: 0, stdout: raw, stderr: '' };
      }
      throw new Error(`unexpected slot command: ${command}`);
    },
  },
});
// Everything below loads after the exec mock, so its slot reads all go through it.
const store = await import('../runs/store.js');
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => current } });
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { reviewFixTurnIsActive, waitForWorkerSignal } = await import('./orchestrator.js');
const { getRunnerObservability } = await import('../runners/registry.js');
// Grok reports its pane session's latest turn, whatever turn the caller leased.
getRunnerObservability('grok')!.getTurnState = async () => {
  const now = Date.now();
  const turn = turns.find((candidate) => now >= candidate.from && now < candidate.to);
  const reading = {
    source: 'signal',
    confidence: 'high',
    observedAt: now,
    sessionId: session,
  } as const;
  return turn
    ? { ...reading, value: 'active', turnToken: turn.token }
    : { ...reading, value: 'idle' };
};

const vars = makeVars({ remoteRepo: '/repo' });
const fixContext = (
  acceptance: Partial<NonNullable<AgentContext['promptAcceptance']>> = {},
): AgentContext => ({
  id: 'review-fix',
  role: 'review-fix',
  runId: 'run-1',
  slotId: vars.slotId,
  label: 'Fix',
  status: 'working',
  updatedAt: deliveryStartedAt,
  runner: 'grok',
  taskFile: 'tasks/run-1/REVIEW-FIX.md',
  signalFile: 'tasks/run-1/REVIEW-FIX-SIGNAL.json',
  target: { session: 'mmt-3', window: 'dev', pane: null, target: 'mmt-3:dev' },
  promptDeliveryStartedAt: deliveryStartedAt,
  promptAcceptance: {
    runner: 'grok',
    deliveryStartedAt,
    turnToken: acceptedToken,
    observedAt: 0,
    sessionId: session,
    sessionPath: `/sessions/${session}`,
    ...acceptance,
  },
});

// Drive the 2 s poll loop on mocked time; each step lets the loop's slot reads settle.
async function waitOnTimeline(t: TestContext, minutes: number) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let settled = false;
  let value: unknown;
  const pending = waitForWorkerSignal(vars, 'tasks/run-1', 30 * MINUTE, baseline, () =>
    reviewFixTurnIsActive(vars, 'run-1', 'grok', acceptedToken),
  ).then((result) => {
    settled = true;
    value = result;
  });
  for (let elapsed = 0; !settled && elapsed < minutes * MINUTE; elapsed += 2000) {
    t.mock.timers.tick(2000);
    for (let flush = 0; flush < 6; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
  }
  await pending;
  return { value, at: Date.now() };
}

// Run 6c5d56fb: the delivery's turn ended, then grok worked on in turns it started itself.
const grokTimeline = (continuation: string) => [
  { from: 0, to: 10 * MINUTE, token: acceptedToken },
  // Idle gap, well under the 30 min progress timeout.
  { from: 12 * MINUTE, to: 35 * MINUTE, token: continuation },
];
const complete = JSON.stringify({ attemptId: 'attempt-1', step: '8. Signal', status: 'complete' });

test('a fix wait follows the worker into its next turn in the same session', async (t) => {
  current = { ...makeRun({ id: 'run-1' }), agentContexts: [fixContext()] };
  turns = grokTimeline(`${session}:1792317219448`);
  signal = { at: 45 * MINUTE, raw: complete };
  const { value, at } = await waitOnTimeline(t, 80);
  assert.equal((value as { status?: string } | undefined)?.status, 'complete');
  assert.ok(at >= 45 * MINUTE && at < 46 * MINUTE, `signal taken at ${at / MINUTE} min`);
});

test('a turn in another session, or after a newer delivery, does not hold the fix lease', async (t) => {
  for (const { context, continuation } of [
    { context: fixContext(), continuation: 'another-session:1792317219448' },
    {
      context: { ...fixContext(), promptDeliveryStartedAt: '2026-10-18T10:16:05.972Z' },
      continuation: `${session}:1792317219448`,
    },
  ]) {
    current = { ...makeRun({ id: 'run-1' }), agentContexts: [context] };
    turns = grokTimeline(continuation);
    signal = { at: 45 * MINUTE, raw: complete };
    const { value, at } = await waitOnTimeline(t, 80);
    assert.equal(value, undefined);
    // The lease ended with the delivery's own turn, so the 30 min progress timeout ran from ~10 min.
    assert.ok(at > 39 * MINUTE && at <= 40 * MINUTE, `timed out at ${at / MINUTE} min`);
    t.mock.timers.reset();
  }
});
