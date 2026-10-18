import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { NATIVE_WORKER_RESPOND } from '@farmslot/agent-runtime/native';
import type { NativeSessionEvent, NativeWorkerSessionBinding } from '@farmslot/protocol';

const calls: Array<{ owner: string; method: string; params: unknown }> = [];
mock.module('../runners/native/node.js', {
  namedExports: {
    routeNativeExecution: async (owner: string, method: string, params: unknown) => {
      calls.push({ owner, method, params });
      return {};
    },
  },
});
const { refuseReviewerApprovals } = await import('./native-reviewer-approvals.js');

const binding: NativeWorkerSessionBinding = {
  sessionId: 'f554978f-e3b5-4705-9bce-a9f2f9397f64',
  executionNodeId: 'macpro',
  ownerPrincipalId: 'farm-automation',
  generation: '8d00cc19-c1ed-45b8-a7b8-c0cfc5fdb794',
  leaseId: '55069106-be4e-4e22-b06e-17a6384a770c',
  commandId: 'c0985138-e080-4735-8a0c-3a914315af8d',
};

// The approval TAT-4145's opus reviewer waited on until its 30-minute review deadline (10-18).
const command =
  'set -e; cd /Users/deeeed/dev/metamask/va-mmcx-terminal-1; D=$(mktemp -d /tmp/rev-tat4145-XXXX); git archive HEAD | tar -x -C "$D"; ln -s /Users/deeeed/dev/metamask/va-mmcx-terminal-1/node_modules "$D/node_modules"; for f in $(git diff --name-only e325edcc..HEAD | grep -vE \'\\.test\\.tsx?$\'); do if git cat-file -e e325edcc:"$f" 2>/dev/null; then git show e325edcc:"$f" > "$D/$f"; else rm "$D/$f"; echo "removed new $f"; fi; done; cp .env* "$D"/ 2>/dev/null || true; echo $D > /tmp/rev-tat4145-dir.txt; echo $D';
const approval: NativeSessionEvent = {
  sessionId: binding.sessionId,
  sequence: 279,
  generation: binding.generation!,
  at: '2026-10-18T08:18:08.730Z',
  type: 'approval.requested',
  commandId: binding.commandId,
  turnId: 'msg_011Cg9MyhETXYgdUVrXVqW5p',
  nativeId: 'ea31c407-8667-4f06-a61a-bbaff1488589',
  request: {
    id: '8d00cc19-c1ed-45b8-a7b8-c0cfc5fdb794:689ff167-6609-4cf4-befa-e74f43c43121',
    title: 'Allow runner action?',
    detail: command,
  },
  data: {
    toolName: 'Bash',
    input: { command, description: 'Export HEAD with source reverted to base' },
  },
};

test('a native reviewer refuses the runner approval it asked for instead of waiting on it', async () => {
  calls.length = 0;
  assert.equal(await refuseReviewerApprovals(binding, { pendingRequests: [approval] }), 1);
  assert.deepEqual(calls, [
    {
      owner: 'farm-automation',
      method: NATIVE_WORKER_RESPOND,
      params: {
        sessionId: binding.sessionId,
        executionNodeId: 'macpro',
        generation: binding.generation,
        leaseId: binding.leaseId,
        requestId: approval.request!.id,
        response: { decision: 'deny' },
      },
    },
  ]);
});

test('a reviewer leaves questions and answers already in flight alone', async () => {
  calls.length = 0;
  const question: NativeSessionEvent = {
    ...approval,
    type: 'question.requested',
    request: { id: 'question-1', title: 'Answer runner questions', questions: [] },
  };
  const answering: NativeSessionEvent = { ...approval, responseState: 'unknown' };
  assert.equal(
    await refuseReviewerApprovals(binding, { pendingRequests: [question, answering] }),
    0,
  );
  assert.deepEqual(calls, []);
});
