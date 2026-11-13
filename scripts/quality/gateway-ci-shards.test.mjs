import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readGatewayShardReports,
  shardSummary,
  verifyGatewayShards,
} from './gateway-ci-shards.mjs';
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

function writeAttempts(t, attempts) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-shards-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [attempt, parts] of attempts) {
    for (const report of parts) {
      const shardDirectory = join(
        directory,
        `gateway-test-shard-${report.shard.index}-attempt-${attempt}`,
      );
      mkdirSync(shardDirectory);
      writeFileSync(join(shardDirectory, 'tsx-tests-gateway.json'), JSON.stringify(report));
    }
  }
  return directory;
}

test('failed-job rerun replaces its stale report and retains successful earlier shards', (t) => {
  const initial = reports();
  initial[2].status = 'fail';
  initial[2].files[0].status = 'fail';
  const directory = writeAttempts(t, [[1, initial]]);
  assert.throws(
    () => verifyGatewayShards(readGatewayShardReports(directory), files),
    /did not pass/,
  );

  const rerun = reports()[2];
  rerun.totalMs = 9000;
  const rerunDirectory = join(directory, 'gateway-test-shard-3-attempt-2');
  mkdirSync(rerunDirectory);
  writeFileSync(join(rerunDirectory, 'tsx-tests-gateway.json'), JSON.stringify(rerun));

  const selected = verifyGatewayShards(readGatewayShardReports(directory), files);
  assert.deepEqual(
    selected.map((report) => report.totalMs),
    [1000, 2000, 9000, 4000],
  );
});

test('latest failed attempt cannot fall back to an older passing report', (t) => {
  const failed = reports()[0];
  failed.status = 'fail';
  const directory = writeAttempts(t, [
    [1, reports()],
    [2, [failed]],
  ]);
  assert.throws(
    () => verifyGatewayShards(readGatewayShardReports(directory), files),
    /did not pass/,
  );
});

test('aggregate-only reruns retain reports and attempt ordering is numeric', (t) => {
  const latest = reports()[1];
  latest.totalMs = 10000;
  const directory = writeAttempts(t, [
    [9, reports()],
    [10, [latest]],
  ]);
  const first = verifyGatewayShards(readGatewayShardReports(directory), files);
  const second = verifyGatewayShards(readGatewayShardReports(directory), files);
  assert.deepEqual(first, second);
  assert.equal(first[1].totalMs, 10000);
});

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
