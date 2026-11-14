import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalBenchResult } from '../../packages/protocol/src/contracts/eval-bench.js';
import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { automationGatewayTarget } from '../lib/gateway-profile.mjs';

const target = await automationGatewayTarget();
assert(target, 'Select an explicit automation/test gateway profile');
const client = await new GatewayClient({ ...target, timeout: 30_000 }).connect();
try {
  const result = await client.call<EvalBenchResult>('eval.bench.get', {});
  assert(result.configured, 'Gateway has no configured benchmark dataset');
  assert(result.trials.length, 'Benchmark index has no trials');
  const item = process.env.FARMSLOT_EVAL_PROOF_ITEM;
  const trials = result.trials.filter((trial) => !item || trial.item === item);
  assert(trials.length, 'Selected benchmark item has no retained trial');
  if (process.env.FARMSLOT_EVAL_REQUIRE_ORIGINAL === '1')
    assert(
      trials.every(
        (trial) =>
          trial.original &&
          trial.original.usage.costUsd !== null &&
          trial.original.usage.turns !== null,
      ),
      'Selected item has no measured original usage',
    );
  const expected = process.env.FARMSLOT_EVAL_EXPECT_PRIMARY;
  if (expected)
    assert(
      trials.every((trial) => trial.verdict === expected),
      'Primary verdict differs from selected proof expectation',
    );
  const merged = process.env.FARMSLOT_EVAL_EXPECT_MERGED;
  if (merged)
    assert(
      trials.every((trial) => trial.verdictVsMerged === merged),
      'Merged verdict differs from selected proof expectation',
    );
  const receipt = {
    status: 'pass',
    dataset: result.dataset,
    item: item ?? 'all',
    trialCount: result.trials.length,
    selected: trials.map((trial) => ({
      runId: trial.runId,
      sourceSha256: trial.sourceSha256,
      verdict: trial.verdict,
      verdictVsMerged: trial.verdictVsMerged,
      original: trial.original,
    })),
    rollups: result.rollups,
  };
  const directory = process.env.FARMSLOT_EVAL_PROOF_OUTPUT;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'benchmark-read.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
  }
  console.log(JSON.stringify(receipt));
} finally {
  client.close();
}
