import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { AgentContext, NativeSessionReadResult, Run } from '@farmslot/protocol';

import { NativeWorkerOperationUncertainError } from '../runners/native/worker-error.js';

import {
  nativeReviewerFailure,
  ReviewerExitedError,
  TerminalReviewArtifactError,
} from './terminal-result.js';

await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const node = await import('../runners/native/node.js');
const owner = await import('../security/native-worker-owner.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
let current: Run;
let response: NativeSessionReadResult;
let duringRead: () => void;
let readError: Error | undefined;
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => current,
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(current, patch),
  },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: {
    ...owner,
    assertNativeRunOwner: () => {},
  },
});
mock.module('../runners/native/node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async () => {
      if (readError) throw readError;
      const snapshot = structuredClone(response);
      duringRead();
      return snapshot;
    },
  },
});
const { readNativeWorkerSnapshot, readNativeWorkerCommandError, confirmNativeWorkerStopped } =
  await import('../runners/native/worker-control.js');
beforeEach(() => {
  const context: AgentContext = {
    id: 'reviewer',
    role: 'review',
    label: 'Review',
    runId: 'run-1',
    slotId: 'slot-1',
    status: 'launching',
    runner: 'claude',
    model: 'opus',
    nativeSession: {
      sessionId: 'reserved',
      leaseId: 'lease',
      commandId: 'command',
      executionNodeId: 'node',
      ownerPrincipalId: 'owner',
    },
  };
  current = { ...makeRun({ status: 'reviewing' }), transport: 'native', agentContexts: [context] };
  duringRead = () => {};
  readError = undefined;
  response = {
    session: {
      id: 'reserved',
      generation: 'created-generation',
      hostPid: 122,
      workerLeaseId: 'lease',
      executionNodeId: 'node',
      ownerPrincipalId: 'owner',
      state: 'failed',
      error: 'runner initialization failed',
      runner: 'claude',
      nativeSessionId: 'conversation',
      accountContextId: 'account',
      cwd: '/fixture',
      executable: 'claude',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: true,
        interrupt: true,
        resume: true,
      },
    },
    events: [],
    pendingRequests: [],
    commands: [],
    cursor: 0,
    hasMore: false,
  };
});
const read = () => readNativeWorkerSnapshot(current.id, 'review', 'reviewer');
const failure = () =>
  new NativeWorkerOperationUncertainError('launch', 'launch unconfirmed', undefined);

test('initialization death is classified from the exact reserved worker before a generation was saved', async () => {
  const original = failure();
  const error = await nativeReviewerFailure(original, read);
  assert.ok(error instanceof ReviewerExitedError);
  assert.equal(error.message, 'runner initialization failed');
  assert.equal(error.cause, original);
  assert.equal(
    current.agentContexts![0]!.nativeSession!.generation,
    undefined,
    'reading a creation failure must not adopt a generation or grant control',
  );
  await assert.rejects(
    confirmNativeWorkerStopped(current.id, 'reviewer'),
    /no current process generation/,
  );
});

test('a stopped process during task acceptance is eligible for the same bounded relaunch', async () => {
  current.agentContexts![0]!.nativeSession!.generation = 'created-generation';
  response.session.processPid = 123;
  response.session.processStopped = true;
  response.session.error = 'runner exited while accepting task';
  const original = new NativeWorkerOperationUncertainError(
    'delivery',
    'acceptance unconfirmed',
    undefined,
  );
  const error = await nativeReviewerFailure(original, read);
  assert.ok(error instanceof ReviewerExitedError);
  assert.equal(error.message, response.session.error);
});

test('failed state with an unconfirmed live process never authorizes relaunch', async () => {
  response.session.processPid = 123;
  response.session.processStopped = false;
  const original = failure();
  assert.equal(await nativeReviewerFailure(original, read), original);
});

test('a launch that is still starting remains uncertain', async () => {
  response.session.state = 'starting';
  const original = failure();
  assert.equal(await nativeReviewerFailure(original, read), original);
});

for (const changed of ['generation', 'leaseId'] as const) {
  test(`a changed ${changed} during startup observation cannot authorize relaunch`, async () => {
    duringRead = () => {
      current.agentContexts![0]!.nativeSession![changed] = 'replacement';
    };
    const original = failure();
    const error = await nativeReviewerFailure(original, read);
    assert.ok(error instanceof NativeWorkerOperationUncertainError);
    assert.equal(error.message, original.message);
    assert.ok(error.cause instanceof AggregateError);
  });
}

test('an unavailable host preserves dispatch uncertainty and both errors', async () => {
  readError = new Error('node temporarily unavailable');
  const original = failure();
  const error = await nativeReviewerFailure(original, read);
  assert.ok(error instanceof NativeWorkerOperationUncertainError);
  assert.ok(error.cause instanceof AggregateError);
  assert.deepEqual(error.cause.errors, [original, readError]);
});

test('a completed invalid report is never reclassified as a native startup exit', async () => {
  const error = new TerminalReviewArtifactError('completed report is invalid');
  assert.equal(
    await nativeReviewerFailure(error, async () => assert.fail('no startup observation')),
    error,
  );
});

function failedCommandEvent(): NativeSessionReadResult['events'][number] {
  return {
    sessionId: 'reserved',
    generation: 'created-generation',
    commandId: 'command',
    sequence: 1,
    at: '2026-10-27T17:21:59.552Z',
    type: 'error',
    text: 'This content was flagged for possible cybersecurity risk.',
    data: { error: { codexErrorInfo: 'cyberPolicy' }, willRetry: false },
  };
}

test('failed reviewer commands retain the structured refusal while the process is still alive', async () => {
  current.agentContexts![0]!.nativeSession!.generation = 'created-generation';
  response.session.state = 'idle';
  response.session.processPid = 123;
  response.session.processStopped = false;
  delete response.session.error;
  response.events = [failedCommandEvent()];
  const error = await readNativeWorkerCommandError(current.id, 'review', 'reviewer');
  assert.equal(error?.message, failedCommandEvent().text);
  assert.deepEqual(error?.cause, failedCommandEvent().data);
  assert.equal(error instanceof ReviewerExitedError, false);
});

test('command failure diagnostics drain earlier history and ignore foreign commands and generations', async () => {
  current.agentContexts![0]!.nativeSession!.generation = 'created-generation';
  response.events = [
    { ...failedCommandEvent(), commandId: 'older-command', text: 'old failure' },
    { ...failedCommandEvent(), generation: 'older-generation', text: 'foreign generation' },
    { ...failedCommandEvent(), sessionId: 'other-session', text: 'foreign session' },
  ];
  response.hasMore = true;
  response.cursor = 500;
  duringRead = () => {
    response.events = [failedCommandEvent()];
    response.hasMore = false;
  };
  const error = await readNativeWorkerCommandError(current.id, 'review', 'reviewer');
  assert.equal(error?.message, failedCommandEvent().text);
  response.events = [{ ...failedCommandEvent(), commandId: 'older-command' }];
  duringRead = () => {};
  assert.equal(await readNativeWorkerCommandError(current.id, 'review', 'reviewer'), undefined);
});

test('a replacement command cannot inherit the failed command diagnostic', async () => {
  current.agentContexts![0]!.nativeSession!.generation = 'created-generation';
  response.events = [failedCommandEvent()];
  duringRead = () => {
    current.agentContexts![0]!.nativeSession!.commandId = 'replacement';
  };
  await assert.rejects(
    readNativeWorkerCommandError(current.id, 'review', 'reviewer'),
    /command changed during failure observation/,
  );
});
