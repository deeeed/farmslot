import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  exportEvalComparisonHtml,
  renderEvalComparisonBody,
} from '../../apps/command-center/ui/src/components/evals/eval-comparison-html.js';
import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import type { EvalBenchComparison } from '../../packages/protocol/src/contracts/eval-bench.js';
import { automationGatewayTarget } from '../lib/gateway-profile.mjs';

const target = await automationGatewayTarget();
assert(target, 'Select an explicit automation/test gateway profile');
const runIds = (process.env.FARMSLOT_EVAL_COMPARE_RUN_IDS ?? '').split(',').filter(Boolean);
assert(runIds.length > 0 && runIds.length <= 2, 'Select one or two retained benchmark run IDs');
const directory = process.env.FARMSLOT_EVAL_COMPARE_OUTPUT;
assert(directory, 'Choose FARMSLOT_EVAL_COMPARE_OUTPUT for the retained proof');
const expected = process.env.FARMSLOT_EVAL_COMPARE_EXPECT ?? 'verified';
assert(
  ['verified', 'identity-unverified', 'base-unverified', 'budget', 'patch-missing'].includes(
    expected,
  ),
);
const client = await new GatewayClient({ ...target, timeout: 30_000 }).connect();
try {
  const result = await client.call<EvalBenchComparison>('eval.bench.comparison.get', { runIds });
  assert.deepEqual(
    result.trials.map((trial) => trial.trial.runId),
    runIds,
  );
  assert(
    result.originalPatch.sha256 && result.originalPatch.text !== null,
    'Original patch is unavailable',
  );
  assert(
    result.original && result.original.usage.costUsd !== null,
    'Original measured usage is unavailable',
  );
  for (const trial of result.trials) {
    if (expected === 'identity-unverified') {
      assert.equal(trial.patch.text, null);
      assert.equal(trial.patch.sha256, null);
      assert.equal(trial.patch.totals, null);
      assert.deepEqual(trial.criteria, []);
      assert.deepEqual(trial.extraFiles, []);
      assert.deepEqual(trial.missingFiles, []);
      assert.match(trial.coverageNote ?? '', /identity unverified/i);
    } else if (expected === 'patch-missing') {
      assert.equal(trial.patch.text, null);
      assert.match(trial.patch.missingReason ?? '', /not available/i);
    } else {
      assert(trial.patch.sha256 && trial.patch.text !== null, 'Candidate patch is unavailable');
      assert.equal(trial.coverageNote, null, 'Retained acceptance ledger is unavailable');
    }
    if (expected === 'verified') {
      assert.match(result.reference.base, /^[a-f0-9]{40}$/i);
      assert.equal(trial.candidateBase?.toLowerCase(), result.reference.base.toLowerCase());
      assert(
        trial.diffOfDiffs !== null && trial.fileComparisons.length > 0,
        'Base-verified patch comparison is unavailable',
      );
    } else {
      assert.equal(trial.diffOfDiffs, null);
      if (expected === 'base-unverified')
        assert.match(trial.comparisonNote ?? '', /not verified equal/);
      if (expected === 'budget') assert.match(trial.comparisonNote ?? '', /budget/i);
      if (expected === 'identity-unverified' || expected === 'patch-missing') {
        const file = result.originalPatch.files[0]?.path;
        assert(file, 'An original file must be available to exercise filtering');
        const filtered = renderEvalComparisonBody(result, 'patches', file);
        assert(filtered.includes(trial.patch.missingReason ?? 'missing reason required'));
        assert(!filtered.includes('This output does not change the selected file'));
        assert(
          !renderEvalComparisonBody(result, 'drift').includes(
            'No extra files in retained patches.',
          ),
        );
      }
    }
  }
  const html = exportEvalComparisonHtml(result);
  assert(html.startsWith('<!doctype html>'));
  assert(html.includes('Content-Security-Policy') && html.includes("default-src 'none'"));
  assert(
    !/<script\b|<iframe\b|<img\b|<link\b/i.test(html),
    'Export must have no active or external elements',
  );
  const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert(
    styles && !/@import|url\(/i.test(styles),
    'Export styles must be inline and self-contained',
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  await writeFile(path.join(directory, 'comparison.html'), html, { mode: 0o600 });
  console.log(
    JSON.stringify({
      status: 'pass',
      expected,
      dataset: result.dataset,
      item: result.item,
      runIds,
      originalPatchSha256: result.originalPatch.sha256,
      originalCostUsd: result.original.usage.costUsd,
      patches: result.trials.map((trial) => ({
        sha256: trial.patch.sha256,
        criteria: trial.criteria.length,
        acClaim: trial.acClaim,
        fileComparisons: trial.fileComparisons.length,
      })),
      htmlBytes: Buffer.byteLength(html),
      selfContained: true,
      proof:
        'Authenticated actual comparison RPC and shared export renderer; UI download is proved separately',
    }),
  );
} finally {
  client.close();
}
