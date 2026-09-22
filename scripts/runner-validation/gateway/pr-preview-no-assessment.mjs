import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(process.env.FARMSLOT_GATEWAY, 'Select an isolated gateway explicitly');
const params = JSON.parse(process.env.PR_PREVIEW_PROOF_PARAMS ?? '{}');
assert.ok(params.id && params.pr, 'Provide a saved rule id and an explicit readable PR target');
function rpc(method, parameters = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(parameters)],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '110000' },
      },
    ),
  );
}
const status = rpc('assessment.status');
assert.equal(status.enabled, true);
assert.equal(
  status.provider,
  'unavailable-proof',
  'Use a non-network provider setting; never prove regressions with a paid key',
);
assert.equal(
  rpc('assessment.list', { limit: 1 }).records.length,
  0,
  'Use an empty isolated assessment store',
);
const before = rpc('prRules.list');
const started = performance.now();
const { preview } = rpc('prRules.preview', params);
assert.ok(performance.now() - started < 110000, 'Preview exceeded client deadline');
assert.ok(preview.items.length > 0, 'Target must exercise a real collected PR');
assert.ok(preview.items.every((item) => !Object.hasOwn(item, 'reviewIntakeAdvisory')));
assert.equal(rpc('assessment.list', { limit: 1 }).records.length, 0, 'Preview created model work');
const after = rpc('prRules.list');
assert.deepEqual(after.intents, before.intents, 'Preview changed review admission');
assert.deepEqual(after.rules, before.rules, 'Preview changed rule configuration or scan state');
console.log(
  JSON.stringify({
    zeroAssessments: true,
    unchangedAdmission: true,
    items: preview.items.length,
    matches: preview.items.filter((item) => item.match.state === 'match').length,
    complete: preview.complete,
  }),
);
