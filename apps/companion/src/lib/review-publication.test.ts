import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { reviewPublicationView } from './review-publication';

const policy = {
  enabled: true,
  source: 'team' as const,
  teamId: 'team',
  account: { host: 'github.com', login: 'reviewer' },
};
function run(overrides: Partial<Run> = {}): Run {
  return {
    status: 'done',
    reviewPublication: {
      checkedAt: 'now',
      direct: {
        ownerId: 'owner',
        pr: { host: 'github.com', repo: 'owner/repo', number: 42 },
        policy,
      },
    },
    ...overrides,
  } as Run;
}
test('publication controls reflect direct opt-in and suppress retry before completion', () => {
  assert.equal(reviewPublicationView(run())?.canRetry, true);
  assert.equal(reviewPublicationView(run({ status: 'monitoring' }))?.canRetry, false);
  const off = run();
  off.reviewPublication!.direct!.policy = { ...policy, enabled: false };
  assert.equal(reviewPublicationView(off)?.label, 'Farmslot results only');
  assert.equal(reviewPublicationView(off)?.canRetry, false);
  assert.equal(reviewPublicationView({} as Run), null);
});
test('a published receipt wins over a stale delivery error', () => {
  const value = run();
  value.reviewPublication!.error = 'Previous response lost';
  value.reviewPublication!.receipt = {
    state: 'published',
    url: 'https://github.com/owner/repo/pull/42#review',
    account: policy.account,
  } as NonNullable<Run['reviewPublication']>['receipt'];
  const view = reviewPublicationView(value)!;
  assert.equal(view.label, 'Published to PR');
  assert.equal(view.error, undefined);
  assert.equal(view.canRetry, false);
  assert.equal(view.account, 'reviewer');
  assert.ok(view.url);
});
