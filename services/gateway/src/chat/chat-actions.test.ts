// chat-actions.test.ts - server-owned Co-Pilot action-card safety checks
// Usage: tsx services/gateway/src/chat/chat-actions.test.ts

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ChatConfirmActionParams, ChatSuggestedAction, RunDecision } from '@farmslot/protocol';

process.env.NODE_ENV = 'test';
const testRoot = mkdtempSync(path.join(tmpdir(), 'farmslot-chat-actions-test-'));
process.env.FARMSLOT_COPILOT_DIR = path.join(testRoot, 'copilot');
process.env.FARMSLOT_RUNS_DIR = path.join(testRoot, 'runs');
await mkdir(process.env.FARMSLOT_COPILOT_DIR, { recursive: true });
await mkdir(process.env.FARMSLOT_RUNS_DIR, { recursive: true });

const {
  CHAT_ACTION_TTL_MS,
  confirmChatAction,
  issueChatSuggestedActions,
  listChatActions,
  resetChatActionsForTests,
  sweepChatActionsForTests,
} = await import('./chat-actions.js');
const { createRun, deleteRun, getRun, updateRun, updateRunStep } = await import('../runs/store.js');
type SlotStub = {
  slot: string;
  lifecycle: string;
  currentRunId: string | null;
  currentFlowType: string | null;
};
const fakeSlots = new Map<string, SlotStub>();
function setFakeSlot(slot: SlotStub): void {
  fakeSlots.set(slot.slot, slot);
}
function clearFakeSlots(): void {
  fakeSlots.clear();
}
// Inject our test-only slot lookup via the globalThis side-channel installed
// by chat-actions.ts when NODE_ENV==='test'. No production export surface to
// reach. The cast is safe — assertSlotActionSnapshot only reads
// { slot, lifecycle, currentRunId } from SlotStatus, which the stub supplies.
type SlotLookupHookFn = (lookup: ((slotId: string) => unknown) | null) => void;
type PatchActionHookFn = (actionId: string, patch: Record<string, unknown>) => boolean;
const testHooks = (
  globalThis as unknown as {
    __farmslot_test_hooks__?: {
      setSlotLookup?: SlotLookupHookFn;
      patchStoredActionParams?: PatchActionHookFn;
    };
  }
).__farmslot_test_hooks__;
if (!testHooks?.setSlotLookup)
  throw new Error(
    'chat-actions test hooks not installed; ensure NODE_ENV=test before importing chat-actions',
  );
testHooks.setSlotLookup((slotId: string) => fakeSlots.get(slotId));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
let ticketSeq = 10_000;

function testTicket(): string {
  ticketSeq += 1;
  return `PROJ-${ticketSeq}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    resetChatActionsForTests();
    clearFakeSlots();
    await fn();
    console.log(`${GREEN}PASS${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}FAIL${RESET} ${name}: ${errorMessage(err)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function assertRejects(fn: () => Promise<unknown>, expectedMessage: string) {
  try {
    await fn();
  } catch (err) {
    const message = errorMessage(err);
    assert(message.includes(expectedMessage), `expected "${expectedMessage}", got "${message}"`);
    return;
  }
  throw new Error(`expected rejection containing "${expectedMessage}"`);
}

function memoryAction(content: string): ChatSuggestedAction {
  return {
    type: 'memory.update',
    label: 'Save memory',
    params: { content },
  };
}

function decisionAction(decisionId: string, actionId = 'accept'): ChatSuggestedAction {
  return {
    type: 'decision.resolve',
    label: 'Accept decision',
    params: { decisionId, actionId },
  };
}

function runCreateAction(): ChatSuggestedAction {
  return {
    type: 'run.create',
    label: 'Dispatch fix',
    params: {
      flowType: 'fix-bug',
      project: 'example-mobile-farm',
      ticketOrPr: testTicket(),
      runner: 'claude',
      model: 'opus',
      ignored: 'not stored',
    },
  };
}

function runCancelAction(runId: string): ChatSuggestedAction {
  return {
    type: 'run.cancel',
    label: 'Cancel run',
    params: { runId, reason: 'Confirmed by Co-Pilot', ignored: 'not stored' },
  };
}

function runDeleteAction(runId: string): ChatSuggestedAction {
  return {
    type: 'run.delete',
    label: 'Remove failed run',
    params: { runId, ignored: 'not stored' },
  };
}

async function confirm(sessionId: string, actionId: string, nowMs = 1_000) {
  return confirmChatAction({ sessionId, actionId }, () => {}, nowMs);
}

await test('issued actions are server-owned and keyed by actionId', () => {
  const [issued] = issueChatSuggestedActions('manual:test', [memoryAction('server-owned')], 1_000);
  assert(!!issued.actionId, 'missing actionId');
  assert(issued.params.content === 'server-owned', 'display params were not normalized');
  assert(
    issued.expiresAt === new Date(1_000 + CHAT_ACTION_TTL_MS).toISOString(),
    `unexpected expiry ${issued.expiresAt}`,
  );
});

await test('unknown action confirmations are rejected', async () => {
  await assertRejects(() => confirm('manual:test', 'chat-action-missing'), 'Unknown action');
});

await test('missing confirmation identifiers are rejected', async () => {
  await assertRejects(
    () =>
      confirmChatAction(
        { actionId: 'chat-action-missing' } as ChatConfirmActionParams,
        () => {},
        1_000,
      ),
    'sessionId is required',
  );
  await assertRejects(
    () =>
      confirmChatAction({ sessionId: 'manual:test' } as ChatConfirmActionParams, () => {}, 1_000),
    'actionId is required',
  );
});

await test('cross-session confirmations are rejected', async () => {
  const [issued] = issueChatSuggestedActions('manual:owner', [memoryAction('owned')], 1_000);
  await assertRejects(
    () => confirm('manual:other', issued.actionId!, 1_001),
    'different Co-Pilot session',
  );
});

await test('expired confirmations are rejected', async () => {
  const [issued] = issueChatSuggestedActions('manual:test', [memoryAction('expired')], 1_000);
  await assertRejects(
    () => confirm('manual:test', issued.actionId!, 1_000 + CHAT_ACTION_TTL_MS),
    'Action expired',
  );
});

await test('reaper removes expired and consumed action cards', async () => {
  const [expired] = issueChatSuggestedActions(
    'manual:test',
    [memoryAction('expired ignored')],
    1_000,
  );
  const [consumed] = issueChatSuggestedActions('manual:test', [memoryAction('consumed')], 2_000);
  await confirm('manual:test', consumed.actionId!, 2_001);
  const removed = sweepChatActionsForTests(1_000 + CHAT_ACTION_TTL_MS);
  assert(removed === 2, `expected 2 swept actions, got ${removed}`);
  await assertRejects(
    () => confirm('manual:test', expired.actionId!, 1_000 + CHAT_ACTION_TTL_MS + 1),
    'Unknown action',
  );
  await assertRejects(() => confirm('manual:test', consumed.actionId!, 2_002), 'Unknown action');
});

await test('consumed confirmations are rejected on replay', async () => {
  const [issued] = issueChatSuggestedActions('manual:test', [memoryAction('consume once')], 1_000);
  await confirm('manual:test', issued.actionId!, 1_001);
  await assertRejects(() => confirm('manual:test', issued.actionId!, 1_002), 'already consumed');
});

await test('failed execution does not consume a still-valid confirmation', async () => {
  const blockingRun = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  const [issued] = issueChatSuggestedActions(
    'manual:test',
    [
      {
        ...runCreateAction(),
        params: {
          ...runCreateAction().params,
          ticketOrPr: blockingRun.ticketOrPr,
        },
      },
    ],
    1_000,
  );

  try {
    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_001),
      'Active run already exists',
    );
    updateRun(blockingRun.id, { status: 'done', completedAt: new Date().toISOString() });
    const result = await confirm('manual:test', issued.actionId!, 1_002);
    const runId = typeof result.result?.runId === 'string' ? result.result.runId : null;
    if (!runId) throw new Error('retry did not return a created run id');
    assert(
      getRun(runId)?.ticketOrPr === blockingRun.ticketOrPr,
      'retry did not create the stored run payload',
    );
    updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(runId);
  } finally {
    if (getRun(blockingRun.id)) {
      updateRun(blockingRun.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(blockingRun.id);
    }
  }
});

await test('mutated browser confirmation params are rejected before execution', async () => {
  const [issued] = issueChatSuggestedActions('manual:test', [memoryAction('original')], 1_000);
  await assertRejects(
    () =>
      confirmChatAction(
        {
          sessionId: 'manual:test',
          actionId: issued.actionId!,
          params: { content: 'mutated' },
        } as unknown as ChatConfirmActionParams,
        () => {},
        1_001,
      ),
    'Mutated action confirmation rejected',
  );
  await confirm('manual:test', issued.actionId!, 1_002);
  const saved = await readFile(path.join(process.env.FARMSLOT_COPILOT_DIR!, 'MEMORY.md'), 'utf-8');
  assert(saved === 'original', `stored action payload was mutated: ${saved}`);
});

await test('confirmation metadata is compatible while action payload mutation is blocked', async () => {
  const [issued] = issueChatSuggestedActions(
    'manual:test',
    [memoryAction('metadata compatible')],
    1_000,
  );
  await confirmChatAction(
    {
      sessionId: 'manual:test',
      actionId: issued.actionId!,
      clientVersion: 'test-client',
      traceId: 'trace-1',
    } as unknown as ChatConfirmActionParams,
    () => {},
    1_001,
  );
  const saved = await readFile(path.join(process.env.FARMSLOT_COPILOT_DIR!, 'MEMORY.md'), 'utf-8');
  assert(
    saved === 'metadata compatible',
    `metadata confirmation did not execute stored payload: ${saved}`,
  );
});

await test('run.cancel confirmations execute from the stored server payload', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const [issued] = issueChatSuggestedActions('manual:test', [runCancelAction(run.id)], 1_000);
    await confirm('manual:test', issued.actionId!, 1_001);
    const cancelled = getRun(run.id);
    assert(cancelled?.status === 'cancelled', `run was not cancelled: ${cancelled?.status}`);
    assert(
      cancelled?.error === 'Confirmed by Co-Pilot',
      `cancel reason was not stored: ${cancelled?.error}`,
    );
  } finally {
    if (getRun(run.id)) await deleteRun(run.id);
  }
});

await test('run.cancel confirmations reject runs replayed after the card was issued', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const [issued] = issueChatSuggestedActions('manual:test', [runCancelAction(run.id)], 1_000);
    updateRun(run.id, { engineState: { generation: 1 } });
    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_001),
      'changed since the action was proposed',
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('two cards targeting the same runId — second confirm rejects with snapshot drift', async () => {
  // Server doesn't serialize confirms; if the operator clicks both cards
  // back-to-back the second confirm must observe the first's mutation and
  // reject. Driven by runGeneration drift on the snapshot guard — same
  // mechanism a real run-engine bump would trigger after a successful
  // run.cancel mutation.
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const cards = issueChatSuggestedActions(
      'manual:test',
      [runCancelAction(run.id), runCancelAction(run.id)],
      1_000,
    );
    assert(cards.length === 2, `expected 2 cards issued for same runId, got ${cards.length}`);

    // Confirm card A. We don't actually invoke the run-engine in this test
    // env; instead simulate the server-side post-state of a successful cancel
    // by bumping engineState.generation, which is what assertRunActionSnapshot
    // checks against the card's stored snapshot.
    updateRun(run.id, { engineState: { generation: 1 } });

    // Card B's stored snapshot still references generation=0 → must reject.
    await assertRejects(
      () => confirm('manual:test', cards[1].actionId!, 1_001),
      'changed since the action was proposed',
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('run.delete confirmations remove terminal runs from stored payload', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  updateRun(run.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: 'test failure',
  });

  const [issued] = issueChatSuggestedActions('manual:test', [runDeleteAction(run.id)], 1_000);
  await confirm('manual:test', issued.actionId!, 1_001);
  assert(!getRun(run.id), 'terminal run was not deleted');
});

await test('run.delete confirmations expand unambiguous short run ids before storing action payloads', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  updateRun(run.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: 'test failure',
  });

  const [issued] = issueChatSuggestedActions(
    'manual:test',
    [runDeleteAction(run.id.slice(0, 8))],
    1_000,
  );
  assert(issued.params.runId === run.id, `short run id was not expanded: ${issued.params.runId}`);
  await confirm('manual:test', issued.actionId!, 1_001);
  assert(!getRun(run.id), 'terminal run was not deleted');
});

await test('run.delete confirmations reject runs replayed after the card was issued', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  updateRun(run.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: 'test failure',
  });
  try {
    const [issued] = issueChatSuggestedActions('manual:test', [runDeleteAction(run.id)], 1_000);
    updateRun(run.id, { engineState: { generation: 1 } });
    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_001),
      'changed since the action was proposed',
    );
  } finally {
    if (getRun(run.id)) await deleteRun(run.id);
  }
});

await test('run.create confirmations return created run id', async () => {
  const [issued] = issueChatSuggestedActions('manual:test', [runCreateAction()], 1_000);
  const result = await confirm('manual:test', issued.actionId!, 1_001);
  const runId = typeof result.result?.runId === 'string' ? result.result.runId : null;
  if (!runId) throw new Error('run.create confirmation did not return runId');
  try {
    assert(!!getRun(runId), 'created run was not stored');
  } finally {
    if (getRun(runId)) {
      updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(runId);
    }
  }
});

await test('run.delete confirmations reject non-terminal runs at confirmation time', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const [issued] = issueChatSuggestedActions('manual:test', [runDeleteAction(run.id)], 1_000);
    await assertRejects(() => confirm('manual:test', issued.actionId!, 1_001), 'is not terminal');
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('decision confirmations execute from the stored server payload', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const decision: RunDecision = {
      id: `decision-${randomUUID().slice(0, 8)}`,
      type: 'plan_confirmation',
      title: 'Confirm plan',
      description: 'Accept the plan',
      actions: [{ id: 'accept', label: 'Accept', style: 'primary' }],
      createdAt: new Date().toISOString(),
    };
    updateRun(run.id, { decisions: [decision] });
    const [issued] = issueChatSuggestedActions(
      'manual:test',
      [decisionAction(decision.id, 'accept')],
      1_000,
    );
    await confirm('manual:test', issued.actionId!, 1_001);
    const resolved = getRun(run.id)?.decisions[0];
    assert(
      resolved?.resolvedAction === 'accept',
      `decision was not resolved from stored payload: ${resolved?.resolvedAction}`,
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('decision confirmations reject a different run with the same decision id', async () => {
  const decisionId = `decision-rekey-${randomUUID().slice(0, 8)}`;
  const firstRun = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  const secondRun = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const decision: RunDecision = {
      id: decisionId,
      type: 'plan_confirmation',
      title: 'Confirm plan',
      description: 'Accept the plan',
      actions: [{ id: 'accept', label: 'Accept', style: 'primary' }],
      createdAt: new Date().toISOString(),
    };
    updateRun(firstRun.id, { decisions: [decision] });
    const [issued] = issueChatSuggestedActions(
      'manual:test',
      [decisionAction(decision.id, 'accept')],
      1_000,
    );
    updateRun(firstRun.id, { decisions: [] });
    updateRun(secondRun.id, {
      decisions: [{ ...decision, createdAt: new Date(Date.now() + 1).toISOString() }],
    });
    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_001),
      'changed since the action was proposed',
    );
  } finally {
    updateRun(firstRun.id, { status: 'done', completedAt: new Date().toISOString() });
    updateRun(secondRun.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(firstRun.id);
    await deleteRun(secondRun.id);
  }
});

await test('allowlist accepts run.replayStep, slot.release, slot.prepare; rejects unknown', async () => {
  // Seed a run whose step is in failed state so run.replayStep passes the issue-time gate
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    // Issue-time allowlist mirrors the operator-side descriptor: only
    // {prepare, run} are server-issuable for replayStep.
    const failedStepName = run.steps.find((s) => s.name === 'prepare')?.name;
    if (!failedStepName) throw new Error('seed run did not contain a prepare step');
    updateRunStep(run.id, failedStepName, { status: 'failed' });

    const issued = issueChatSuggestedActions(
      'manual:test',
      [
        {
          type: 'run.replayStep',
          label: 'Replay failed step',
          params: { runId: run.id, step: failedStepName },
        },
        { type: 'slot.release', label: 'Release stuck slot', params: { slotId: 'mini-mm-1' } },
        { type: 'slot.prepare', label: 'Prepare slot', params: { slotId: 'mini-mm-1' } },
        {
          type: 'unknown.type',
          label: 'Unknown',
          params: { foo: 'bar' },
        } as unknown as ChatSuggestedAction,
      ],
      1_000,
    );

    const types = issued.map((action) => action.type).join(',');
    assert(
      types === 'run.replayStep,slot.release,slot.prepare',
      `unexpected issued action types: ${types}`,
    );
    assert(
      issued.every((action) => !!action.actionId),
      'not all issued actions have actionId',
    );
    assert(
      issued[0].params.runId === run.id,
      `run.replayStep runId not stored: ${issued[0].params.runId}`,
    );
    assert(
      issued[0].params.step === failedStepName,
      `run.replayStep step not stored: ${issued[0].params.step}`,
    );
    assert(
      issued[1].params.slotId === 'mini-mm-1',
      `slot.release slotId not stored: ${issued[1].params.slotId}`,
    );
    assert(
      issued[2].params.slotId === 'mini-mm-1',
      `slot.prepare slotId not stored: ${issued[2].params.slotId}`,
    );
    assert(!('branch' in issued[2].params), 'slot.prepare must not carry branch');
    assert(!('mergeMain' in issued[2].params), 'slot.prepare must not carry mergeMain');
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('issue-time gate drops run.replayStep for non-{prepare,run} steps', async () => {
  // The issue-time gate must mirror the operator descriptor allowlist —
  // otherwise an LLM-emitted card for `grade` or `dispatch` would land in
  // the registry and METHOD_ERROR at confirm time.
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const gradeStep = run.steps.find((s) => s.name === 'grade')?.name;
    const prepareStep = run.steps.find((s) => s.name === 'prepare')?.name;
    if (!gradeStep || !prepareStep) throw new Error('seed run missing expected steps');
    updateRunStep(run.id, gradeStep, { status: 'failed' });
    updateRunStep(run.id, prepareStep, { status: 'failed' });

    const issued = issueChatSuggestedActions(
      'manual:gate-test',
      [
        {
          type: 'run.replayStep',
          label: 'Replay grade',
          params: { runId: run.id, step: gradeStep },
        },
        {
          type: 'run.replayStep',
          label: 'Replay prepare',
          params: { runId: run.id, step: prepareStep },
        },
      ],
      1_000,
    );

    const types = issued.map((a) => `${a.type}:${(a.params as Record<string, unknown>).step}`);
    assert(
      types.length === 1,
      `expected 1 issued action (prepare only), got ${types.length}: ${types.join(',')}`,
    );
    assert(
      types[0] === `run.replayStep:${prepareStep}`,
      `expected only prepare to pass the gate, got ${types[0]}`,
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('run.replayStep rejects stale cards on generation drift (snapshot-mismatch)', async () => {
  // P2 round-8: a replayStep card whose target step is still 'failed' but
  // whose run state has moved (engine bumped generation, slot rebound, etc.)
  // must reject just like run.cancel/run.delete do, instead of silently
  // re-running against a now-different run.
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const prepareStep = run.steps.find((s) => s.name === 'prepare')?.name;
    if (!prepareStep) throw new Error('seed run missing prepare step');
    updateRunStep(run.id, prepareStep, { status: 'failed' });

    const [issued] = issueChatSuggestedActions(
      'manual:test',
      [
        {
          type: 'run.replayStep',
          label: 'Replay prepare',
          params: { runId: run.id, step: prepareStep },
        },
      ],
      1_000,
    );
    assert(Boolean(issued?.actionId), 'replayStep card was not issued');

    // Simulate the engine bumping generation after the card was issued.
    updateRun(run.id, { engineState: { generation: 1 } });

    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_001),
      'changed since the action was proposed',
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('run.replayStep precondition rejects non-terminal step', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const stepName = run.steps[0]?.name;
    if (!stepName) throw new Error('seed run had no steps');
    // Step is left in default 'pending' state (or set explicitly to a passing one)
    updateRunStep(run.id, stepName, { status: 'done' });

    const issued = issueChatSuggestedActions(
      'manual:test',
      [{ type: 'run.replayStep', label: 'Replay step', params: { runId: run.id, step: stepName } }],
      1_000,
    );

    assert(
      issued.length === 0,
      `expected no actions issued for non-terminal step, got ${issued.length}`,
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('run.replayStep confirm-time gate mirrors {prepare,run} allowlist', async () => {
  // N1 regression: the issue-time gate restricts step ∈ {prepare, run}.
  // A future re-issue / fixture seed shouldn't be able to slip a non-allowed
  // step past confirm. We side-step the issue-time gate by mutating the
  // stored card's params after issuance (simulating a leaked entry).
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const prepareStep = run.steps.find((s) => s.name === 'prepare')?.name;
    const gradeStep = run.steps.find((s) => s.name === 'grade')?.name;
    if (!prepareStep || !gradeStep) throw new Error('seed run missing expected steps');
    updateRunStep(run.id, prepareStep, { status: 'failed' });
    updateRunStep(run.id, gradeStep, { status: 'failed' });

    const [issued] = issueChatSuggestedActions(
      'manual:test',
      [
        {
          type: 'run.replayStep',
          label: 'Replay prepare',
          params: { runId: run.id, step: prepareStep },
        },
      ],
      1_000,
    );

    // Hot-swap the stored card's step to one outside the allowlist via the
    // globalThis test hook (listChatActions returns clones).
    const patched = testHooks.patchStoredActionParams?.(issued.actionId!, { step: gradeStep });
    assert(patched === true, 'patchStoredActionParams hook unavailable');

    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_002),
      'restricted to {prepare, run}',
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('precondition-invalid confirmations are rejected', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: testTicket(),
  });
  try {
    const decision: RunDecision = {
      id: `decision-invalid-${randomUUID().slice(0, 8)}`,
      type: 'plan_confirmation',
      title: 'Confirm plan',
      description: 'Accept the plan',
      actions: [{ id: 'accept', label: 'Accept', style: 'primary' }],
      createdAt: new Date().toISOString(),
    };
    updateRun(run.id, { decisions: [decision] });
    const [issued] = issueChatSuggestedActions(
      'manual:test',
      [decisionAction(decision.id, 'accept')],
      1_000,
    );
    updateRun(run.id, {
      decisions: [{ ...decision, resolvedAt: new Date().toISOString(), resolvedAction: 'accept' }],
    });
    await assertRejects(
      () => confirm('manual:test', issued.actionId!, 1_001),
      'Action precondition failed',
    );
  } finally {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
});

await test('slot.release rejects on slot lifecycle drift (snapshot-mismatch)', async () => {
  setFakeSlot({
    slot: 'mini-mm-1',
    lifecycle: 'busy',
    currentRunId: 'r1',
    currentFlowType: 'fix-bug',
  });
  const [issued] = issueChatSuggestedActions(
    'manual:test',
    [{ type: 'slot.release', label: 'Release slot', params: { slotId: 'mini-mm-1' } }],
    1_000,
  );
  setFakeSlot({
    slot: 'mini-mm-1',
    lifecycle: 'ready',
    currentRunId: 'r1',
    currentFlowType: 'fix-bug',
  });
  try {
    await confirm('manual:test', issued.actionId!, 1_001);
    throw new Error('expected rejection');
  } catch (err) {
    const message = errorMessage(err);
    // Round-4: messages now name the specific delta so the operator can act
    // on the rejection without round-tripping logs.
    assert(
      message.includes('lifecycle changed') &&
        message.includes('snapshot=busy') &&
        message.includes('current=ready'),
      `unexpected message: ${message}`,
    );
    const reason = (err as { reason?: string }).reason;
    assert(reason === 'snapshot-mismatch', `expected reason=snapshot-mismatch, got ${reason}`);
  }
});

await test('slot.release rejects on runId rebind (snapshot-mismatch)', async () => {
  setFakeSlot({
    slot: 'mini-mm-1',
    lifecycle: 'busy',
    currentRunId: 'r1',
    currentFlowType: 'fix-bug',
  });
  const [issued] = issueChatSuggestedActions(
    'manual:test',
    [{ type: 'slot.release', label: 'Release slot', params: { slotId: 'mini-mm-1' } }],
    1_000,
  );
  setFakeSlot({
    slot: 'mini-mm-1',
    lifecycle: 'busy',
    currentRunId: 'r2',
    currentFlowType: 'fix-bug',
  });
  try {
    await confirm('manual:test', issued.actionId!, 1_001);
    throw new Error('expected rejection');
  } catch (err) {
    const message = errorMessage(err);
    assert(
      message.includes('bound run changed') &&
        message.includes('snapshot=r1') &&
        message.includes('current=r2'),
      `unexpected message: ${message}`,
    );
    const reason = (err as { reason?: string }).reason;
    assert(reason === 'snapshot-mismatch', `expected reason=snapshot-mismatch, got ${reason}`);
  }
});

await test('listChatActions returns active actions for sessionId; empty for unknown sessionId; excludes consumed and expired entries', async () => {
  // Active + consumed + expired (via reaper sweep) so the result isolates the "exclude expired/consumed" rule.
  const issued = issueChatSuggestedActions(
    'manual:list',
    [memoryAction('first'), memoryAction('second'), memoryAction('third')],
    1_000,
  );
  await confirm('manual:list', issued[0].actionId!, 1_001);
  sweepChatActionsForTests(1_000 + CHAT_ACTION_TTL_MS + 1);
  const [reissued] = issueChatSuggestedActions('manual:list', [memoryAction('third')], 2_000);

  const live = listChatActions('manual:list', 2_001);
  assert(live.length === 1, `listChatActions should return 1 live entry, got ${live.length}`);
  assert(live[0].actionId === reissued.actionId, `unexpected actionId: ${live[0].actionId}`);
  assert(live[0].type === 'memory.update', `unexpected type: ${live[0].type}`);
  assert(/^\d{4}-/.test(live[0].issuedAt), `issuedAt should be ISO: ${live[0].issuedAt}`);
  assert(
    live[0].params.content === 'third',
    `params.content should round-trip: ${JSON.stringify(live[0].params)}`,
  );

  const unknown = listChatActions('manual:does-not-exist');
  assert(
    Array.isArray(unknown) && unknown.length === 0,
    `unknown sessionId should yield [], got ${JSON.stringify(unknown)}`,
  );
});

await test('emits issuance, confirm-success, and confirm-reject log lines', async () => {
  const originalLog = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    const [issued] = issueChatSuggestedActions('manual:owner', [memoryAction('telemetry')], 1_000);
    await confirm('manual:owner', issued.actionId!, 1_001);

    const [crossSession] = issueChatSuggestedActions(
      'manual:owner',
      [memoryAction('rejected')],
      1_002,
    );
    try {
      await confirm('manual:other', crossSession.actionId!, 1_003);
    } catch {
      /* expected reject — captured via log */
    }
  } finally {
    console.log = originalLog;
  }

  const hasRegister = captured.some((line) => line.startsWith('[chat-actions] register actionId='));
  const hasConfirm = captured.some(
    (line) => line.startsWith('[chat-actions] confirm actionId=') && line.includes('ok=true'),
  );
  const hasReject = captured.some(
    (line) =>
      line.startsWith('[chat-actions] reject actionId=') && line.includes('reason=cross-session'),
  );
  assert(hasRegister, `missing register log; captured: ${captured.join('\n')}`);
  assert(hasConfirm, `missing confirm log; captured: ${captured.join('\n')}`);
  assert(hasReject, `missing reject log; captured: ${captured.join('\n')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
