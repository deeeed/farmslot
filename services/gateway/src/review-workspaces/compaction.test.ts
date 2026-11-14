import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { NativeContextCompactionRequest } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'review-compaction-'));
process.env.FARMSLOT_RUNS_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { prepareReviewCompaction, unsupportedCompaction } = await import('./compaction.js');
after(() => rm(root, { recursive: true, force: true }));

function fixture() {
  const run = createRun({
    project: 'review-fixture',
    flowType: 'review-pr',
    ticketOrPr: 'example/repo#1',
  });
  updateRun(run.id, {
    repeatReviewContext: {
      version: 1,
      chainId: 'chain',
      generation: 2,
      priorRunId: 'prior',
      priorFamilyId: 'family',
      repository: 'example/repo',
      prNumber: 1,
      currentHeadSha: 'b'.repeat(40),
      priorReviewedHeadSha: 'a'.repeat(40),
      verdict: 'APPROVE',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode: 'warm',
      validationDepth: 'static-code',
      session: {
        mode: 'warm',
        continuity: 'resumed',
        reviewId: 'lineage',
        priorSessionId: 'provider-session',
      },
    },
  });
  return {
    runId: run.id,
    providerSessionId: 'provider-session',
    preparation: {
      packetDigest: 'f'.repeat(64),
      focus: 'Retain findings, retire completed task commands.',
    },
    assertCurrent: () => {},
  };
}

function confirmed(request: NativeContextCompactionRequest) {
  return {
    ...unsupportedCompaction(request, ''),
    status: 'confirmed',
    reason: undefined,
    evidence: {
      nativeSessionId: request.nativeSessionId,
      boundaryId: 'manual-boundary',
      completedAt: new Date().toISOString(),
    },
  };
}

test('gateway checkpoints intent before send and confirms the exact packet once', async () => {
  const f = fixture();
  let sends = 0;
  const execute = async (request: NativeContextCompactionRequest) => {
    sends++;
    assert.equal(getRun(f.runId)?.repeatReviewContext?.session?.compaction?.status, 'pending');
    assert.equal(request.packetDigest, f.preparation.packetDigest);
    return confirmed(request);
  };
  const input = { ...f, execute, reconcile: async () => undefined };
  await prepareReviewCompaction(input);
  await prepareReviewCompaction(input);
  assert.equal(sends, 1);
  const saved = getRun(f.runId)?.repeatReviewContext?.session?.compaction;
  assert.equal(saved?.status, 'confirmed');
  assert.equal(saved.focusSha256, createHash('sha256').update(f.preparation.focus).digest('hex'));
});

test('lost replies reconcile the saved operation without another provider send', async () => {
  const f = fixture();
  let request: NativeContextCompactionRequest | undefined;
  let sends = 0;
  await assert.rejects(
    prepareReviewCompaction({
      ...f,
      execute: async (value) => {
        sends++;
        request = value;
        throw new Error('reply lost');
      },
      reconcile: async () => undefined,
    }),
    /uncertain/,
  );
  assert.equal(getRun(f.runId)?.repeatReviewContext?.session?.compaction?.status, 'unconfirmed');
  await prepareReviewCompaction({
    ...f,
    execute: async () => {
      sends++;
      throw new Error('must not send');
    },
    reconcile: async () => {
      assert(request);
      return confirmed(request);
    },
  });
  assert.equal(sends, 1);
  assert.equal(getRun(f.runId)?.repeatReviewContext?.session?.compaction?.status, 'confirmed');
});

test('unsupported compaction retains the session and unfinished recovery skips maintenance', async () => {
  const f = fixture();
  let sends = 0;
  const execute = async (request: NativeContextCompactionRequest) => {
    sends++;
    return unsupportedCompaction(request, 'Structured compaction unsupported');
  };
  await prepareReviewCompaction({
    ...f,
    unfinishedRecovery: true,
    execute,
    reconcile: async () => undefined,
  });
  assert.equal(sends, 0);
  await prepareReviewCompaction({ ...f, execute, reconcile: async () => undefined });
  const trace = getRun(f.runId)?.repeatReviewContext?.session;
  assert.equal(trace?.continuity, 'resumed');
  assert.equal(trace.compaction?.status, 'unsupported');
  assert.equal(trace.priorSessionId, f.providerSessionId);
});

test('foreign session and completion evidence never bind a new task', async () => {
  const f = fixture();
  let sends = 0;
  const execute = async (request: NativeContextCompactionRequest) => {
    sends++;
    return {
      ...confirmed(request),
      evidence: {
        nativeSessionId: 'foreign',
        boundaryId: 'boundary',
        completedAt: new Date().toISOString(),
      },
    };
  };
  await assert.rejects(
    prepareReviewCompaction({
      ...f,
      providerSessionId: 'foreign',
      execute,
      reconcile: async () => undefined,
    }),
    /retained conversation/,
  );
  assert.equal(sends, 0);
  await assert.rejects(
    prepareReviewCompaction({ ...f, execute, reconcile: async () => undefined }),
    /exact-session/,
  );
  assert.equal(getRun(f.runId)?.repeatReviewContext?.session?.compaction?.status, 'unconfirmed');
});

test('a reconciliation transport failure remains uncertain without another maintenance send', async () => {
  const f = fixture();
  const input = {
    ...f,
    execute: async () => {
      throw new Error('lost reply');
    },
    reconcile: async () => {
      throw new Error('node offline');
    },
  };
  await assert.rejects(prepareReviewCompaction(input), {
    name: 'NativeWorkerOperationUncertainError',
  });
  assert.equal(getRun(f.runId)?.repeatReviewContext?.session?.compaction?.status, 'unconfirmed');
  await assert.rejects(
    prepareReviewCompaction({
      ...input,
      execute: async () => {
        assert.fail('must not send');
      },
    }),
    { name: 'NativeWorkerOperationUncertainError' },
  );
});
