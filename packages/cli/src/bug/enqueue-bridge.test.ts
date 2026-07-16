import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type BridgeGatewayClient, enqueueScoredBugs } from './enqueue-bridge.js';

async function scoresDirWith(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'enqueue-bridge-'));
  for (const [key, content] of Object.entries(files)) {
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify(content), 'utf-8');
  }
  return dir;
}

function fakeClient(input: { existing?: Array<{ sourceRef: string }>; failCreateFor?: string[] }): {
  client: BridgeGatewayClient;
  creates: Array<Record<string, unknown>>;
} {
  const creates: Array<Record<string, unknown>> = [];
  const client: BridgeGatewayClient = {
    async call<T>(method: string, params: unknown): Promise<T> {
      if (method === 'backlog.list') {
        return { items: input.existing ?? [] } as T;
      }
      if (method === 'backlog.create') {
        const p = params as Record<string, unknown>;
        if (input.failCreateFor?.includes(p.sourceRef as string)) {
          throw new Error(`create rejected for ${p.sourceRef as string}`);
        }
        creates.push(p);
        return { item: { id: 'id-x', sourceRef: 'MANUAL-000099' } } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, creates };
}

test('enqueue bridge creates items above threshold and skips the rest with reasons', async (t) => {
  const dir = await scoresDirWith({
    'gh-1': {
      issue_ref: 'owner/repo#1',
      bug_input: { title: 'Crash on save' },
      final: { one_shot_probability: 0.9, recommended_model: 'sonnet' },
    },
    'gh-2': { issue_ref: 'owner/repo#2', heuristic: { one_shot_probability: 0.3 } },
    'gh-3': {
      issue_ref: 'owner/repo#3',
      final: { one_shot_probability: 0.95 },
      validation: { still_valid: false, confidence: 0.9, reason: 'fixed upstream' },
    },
    'gh-4': { issue_ref: 'owner/repo#4' },
    'gh-5': { issue_ref: 'owner/repo#5', heuristic: { one_shot_probability: 0.8 } },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { client, creates } = fakeClient({ existing: [{ sourceRef: 'OWNER/REPO#5' }] });

  const result = await enqueueScoredBugs(client, {
    project: 'farmslot-farm',
    source: 'github',
    scoresDir: dir,
    keys: ['gh-1', 'gh-2', 'gh-3', 'gh-4', 'gh-5'],
    threshold: 0.7,
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]?.ref, 'owner/repo#1');
  assert.equal(result.created[0]?.probability, 0.9);
  assert.equal(result.skippedBelowThreshold, 1); // gh-2
  assert.deepEqual(result.skippedInvalid, ['owner/repo#3']);
  assert.deepEqual(result.skippedNoScore, ['owner/repo#4']);
  // dedup is case-insensitive against existing sourceRefs
  assert.equal(result.skippedExisting.length, 1);
  assert.equal(result.skippedExisting[0]?.ref, 'owner/repo#5');
  assert.equal(result.failures.length, 0);

  // the created item carries the intake contract
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.sourceKind, 'github');
  assert.equal(creates[0]?.sourceRef, 'owner/repo#1');
  assert.equal(creates[0]?.flowType, 'fix-bug');
  assert.equal(creates[0]?.title, 'Crash on save');
  assert.deepEqual(creates[0]?.tags, ['bug-intake']);
});

test('enqueue bridge continues past per-item create failures and missing files', async (t) => {
  const dir = await scoresDirWith({
    'gh-7': { issue_ref: 'owner/repo#7', heuristic: { one_shot_probability: 0.8 } },
    'gh-8': { issue_ref: 'owner/repo#8', heuristic: { one_shot_probability: 0.9 } },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { client, creates } = fakeClient({ failCreateFor: ['owner/repo#7'] });

  const result = await enqueueScoredBugs(client, {
    project: 'farmslot-farm',
    source: 'github',
    scoresDir: dir,
    keys: ['gh-7', 'missing-key', 'gh-8'],
    threshold: 0.7,
  });

  // gh-7's create rejection is a recorded failure, not an abort; gh-8 still lands.
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]?.error ?? '', /create rejected for owner\/repo#7/);
  assert.deepEqual(result.skippedNoScore, ['missing-key']);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]?.ref, 'owner/repo#8');
  assert.equal(creates.length, 1);
});
