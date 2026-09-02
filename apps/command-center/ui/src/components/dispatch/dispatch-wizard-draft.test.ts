import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparePhase } from '@farmslot/protocol';

import {
  appLabel,
  buildPublicationReviewDepth,
  buildPublicationReviewGateParams,
  buildPublicationReviewPlan,
  defaultExtraReviewRunner,
  modeForFlow,
  projectApps,
  projectPrepareProfiles,
  publicationReviewsEnabled,
  selectedDispatchApp,
  selectedTaskTemplate,
  selectedTemplateMode,
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
      extraLoopsRequested: 0,
      countingVersion: 2,
      requireCrossRunner: true,
      requestedBy: 'dispatch',
    },
    pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
  });
  assert.deepEqual(
    buildPublicationReviewGateParams('dev', 'claude', loops, runners, 'autonomous'),
    {
      reviewDepth: {
        minimumIndependentReviews: 1,
        extraLoopsRequested: 0,
        countingVersion: 2,
        requireCrossRunner: true,
        requestedBy: 'dispatch',
      },
      pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
    },
  );
});

test('publication review depth counts configured loops once', () => {
  assert.deepEqual(
    buildPublicationReviewDepth('fix-bug', 'claude', [
      { order: 1, runner: 'codex' },
      { order: 2, runner: 'cursor' },
    ]),
    {
      minimumIndependentReviews: 1,
      extraLoopsRequested: 1,
      countingVersion: 2,
      requireCrossRunner: true,
      requestedBy: 'dispatch',
    },
  );
});

test('default draft choices derive from flow and current runner', () => {
  assert.equal(modeForFlow('fix-bug'), 'autonomous');
  assert.equal(modeForFlow('review-pr'), 'interactive');
  assert.equal(modeForFlow('pr-complete'), 'autonomous');
  assert.equal(defaultExtraReviewRunner('claude', runners), 'codex');
  assert.equal(defaultExtraReviewRunner('missing', runners), 'codex');
});

test('selectedTemplateMode derives mode from task template selection', () => {
  const devOptions = [
    { fileName: 'dev.md', label: 'dev (default)', isDefault: true, flowType: 'dev' as const },
    {
      fileName: 'dev-interactive.md',
      label: 'dev · interactive',
      isDefault: false,
      flowType: 'dev' as const,
      variant: 'interactive',
    },
  ];
  assert.equal(selectedTemplateMode('dev', devOptions, 'dev-interactive.md'), 'interactive');
  assert.equal(selectedTemplateMode('dev', devOptions, 'dev.md'), 'autonomous');

  const prCompleteOptions = [
    {
      fileName: 'pr-complete.md',
      label: 'pr-complete (default)',
      isDefault: true,
      flowType: 'pr-complete' as const,
    },
    {
      fileName: 'pr-complete-interactive.md',
      label: 'pr-complete · interactive',
      isDefault: false,
      flowType: 'pr-complete' as const,
      variant: 'interactive',
    },
  ];
  assert.equal(
    selectedTemplateMode('pr-complete', prCompleteOptions, 'pr-complete-interactive.md'),
    'interactive',
  );
  assert.equal(
    selectedTemplateMode('pr-complete', prCompleteOptions, 'pr-complete.md'),
    'autonomous',
  );

  const fixBugOptions = [
    {
      fileName: 'fix-bug.md',
      label: 'fix-bug (default)',
      isDefault: true,
      flowType: 'fix-bug' as const,
    },
    {
      fileName: 'fix-bug-interactive.md',
      label: 'fix-bug · interactive',
      isDefault: false,
      flowType: 'fix-bug' as const,
      variant: 'interactive',
    },
  ];
  assert.equal(selectedTemplateMode('fix-bug', fixBugOptions, 'fix-bug.md'), 'autonomous');
  assert.equal(
    selectedTemplateMode('fix-bug', fixBugOptions, 'fix-bug-interactive.md'),
    'interactive',
  );
  assert.equal(selectedTemplateMode('dev', [], ''), 'interactive');
});

test('projectPrepareProfiles maps profiles with labels and default star', () => {
  const configs = [
    {
      name: 'demo',
      prepare: {
        default: 'relaunch',
        profiles: {
          full: { phases: ['git', 'deps'] as PreparePhase[] },
          relaunch: {
            phases: ['git'] as PreparePhase[],
            label: 'Relaunch app',
            description: 'Restart the app',
          },
        },
      },
    },
  ];
  assert.deepEqual(projectPrepareProfiles(configs, 'demo'), [
    { name: 'full', label: 'full', isDefault: false },
    { name: 'relaunch', label: 'Relaunch app', description: 'Restart the app', isDefault: true },
  ]);
  // No explicit default → a profile literally named "full" is the implicit default.
  const noDefault = [
    { name: 'demo', prepare: { profiles: { full: { phases: ['git'] as PreparePhase[] } } } },
  ];
  assert.equal(projectPrepareProfiles(noDefault, 'demo')[0]?.isDefault, true);
  assert.deepEqual(projectPrepareProfiles(configs, 'other'), []);
});
