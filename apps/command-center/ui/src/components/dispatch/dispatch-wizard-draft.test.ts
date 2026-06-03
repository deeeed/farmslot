import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appLabel,
  buildPublicationReviewGateParams,
  buildPublicationReviewPlan,
  defaultExtraReviewRunner,
  modeForFlow,
  projectApps,
  publicationReviewsEnabled,
  selectedDispatchApp,
  selectedTaskTemplate,
  syncSelectedAppForProject,
} from './dispatch-wizard-draft.js';

const runners = ['claude', 'codex'] as const;

test('selectedTaskTemplate omits default template and returns explicit variants', () => {
  const options = [
    { fileName: 'default.md', label: 'default', isDefault: true, flowType: 'dev' as const },
    {
      fileName: 'custom.md',
      label: 'custom',
      isDefault: false,
      flowType: 'dev' as const,
      variant: 'v2',
    },
  ];
  assert.equal(selectedTaskTemplate(options, 'default.md'), undefined);
  assert.deepEqual(selectedTaskTemplate(options, 'custom.md'), {
    fileName: 'custom.md',
    variant: 'v2',
  });
});

test('project app helpers select only for multi-app projects', () => {
  const configs = [
    { name: 'mobile', apps: ['ios/app', 'android/app'] },
    { name: 'single', apps: ['root'] },
  ];
  assert.deepEqual(projectApps(configs, 'mobile'), ['ios/app', 'android/app']);
  assert.equal(syncSelectedAppForProject(['ios/app', 'android/app'], ''), 'ios/app');
  assert.equal(syncSelectedAppForProject(['ios/app', 'android/app'], 'android/app'), 'android/app');
  assert.equal(selectedDispatchApp(['root'], 'root'), undefined);
  assert.equal(selectedDispatchApp(['ios/app', 'android/app'], ''), 'ios/app');
  assert.equal(appLabel('apps/mobile'), 'mobile');
});

test('publication review draft builds gate params for fix-bug and autonomous dev only', () => {
  const loops = [{ id: 1, runner: 'codex' as const }];
  assert.deepEqual(buildPublicationReviewPlan('review-pr', 'claude', loops, runners), []);
  assert.deepEqual(buildPublicationReviewPlan('dev', 'claude', loops, runners, 'interactive'), []);
  assert.equal(publicationReviewsEnabled('dev', 'autonomous'), true);
  assert.deepEqual(buildPublicationReviewGateParams('fix-bug', 'claude', loops, runners), {
    reviewDepth: {
      minimumIndependentReviews: 1,
      extraLoopsRequested: 1,
      requireCrossRunner: true,
      requestedBy: 'dispatch',
    },
    pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'full-live' }],
  });
  assert.deepEqual(
    buildPublicationReviewGateParams('dev', 'claude', loops, runners, 'autonomous'),
    {
      reviewDepth: {
        minimumIndependentReviews: 1,
        extraLoopsRequested: 1,
        requireCrossRunner: true,
        requestedBy: 'dispatch',
      },
      pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'full-live' }],
    },
  );
});

test('default draft choices derive from flow and current runner', () => {
  assert.equal(modeForFlow('fix-bug'), 'autonomous');
  assert.equal(modeForFlow('review-pr'), 'interactive');
  assert.equal(defaultExtraReviewRunner('claude', runners), 'codex');
  assert.equal(defaultExtraReviewRunner('missing', runners), 'codex');
});
