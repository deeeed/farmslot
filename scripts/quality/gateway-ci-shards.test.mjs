import assert from 'node:assert/strict';
import test from 'node:test';

import { shardSummary, verifyGatewayShards } from './gateway-ci-shards.mjs';
import { parseShard, selectShard } from './run-tsx-tests.mjs';

const files = Array.from({ length: 13 }, (_, index) => `src/test-${index}.test.ts`);
function reports() {
  return [1, 2, 3, 4].map((index) => ({
    workspace: 'gateway',
    status: 'ok',
    assignment: { ok: true },
    shard: { index, total: 4 },
    totalMs: index * 1000,
    files: selectShard(files, parseShard(`${index}/4`)).map((file) => ({ file, status: 'ok' })),
  }));
}

test('aggregate requires every file exactly once and reports per-shard times', () => {
  const result = verifyGatewayShards(reports().reverse(), files);
  assert.deepEqual(
    result.map((report) => report.shard.index),
    [1, 2, 3, 4],
  );
  assert.match(shardSummary(result), /\| 1\/4 \| 4 \| 1.0s \|/);
  assert.match(shardSummary(result), /\| 4\/4 \| 3 \| 4.0s \|/);
});

test('aggregate rejects missing or inconsistent shard identities', () => {
  assert.throws(() => verifyGatewayShards([], files), /missing/);
  assert.throws(() => verifyGatewayShards(reports().slice(1), files), /requires 4/);
  const duplicate = reports();
  duplicate[1].shard.index = 1;
  assert.throws(() => verifyGatewayShards(duplicate, files), /repeat/);
  const disagreement = reports();
  disagreement[0].shard.total = 5;
  assert.throws(() => verifyGatewayShards(disagreement, files), /disagree/);
});

test('aggregate rejects failed, skipped, or incomplete test execution', () => {
  for (const status of ['fail', 'skipped']) {
    const failed = reports();
    failed[0].files[0].status = status;
    assert.throws(() => verifyGatewayShards(failed, files), /did not pass/);
  }
  const failed = reports();
  failed[0].status = 'fail';
  assert.throws(() => verifyGatewayShards(failed, files), /did not pass/);
});

test('aggregate detects dropped, repeated, or unexpected files independently', () => {
  for (const mutate of [
    (parts) => parts[0].files.pop(),
    (parts) => parts[1].files.push(parts[0].files[0]),
    (parts) => parts[0].files.push({ file: 'src/unexpected.test.ts', status: 'ok' }),
  ]) {
    const parts = reports();
    mutate(parts);
    assert.throws(() => verifyGatewayShards(parts, files), /coverage failed/);
  }
});
