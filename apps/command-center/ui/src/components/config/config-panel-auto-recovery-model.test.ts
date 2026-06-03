import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { ProjectConfig } from '@farmslot/protocol';

import {
  autoRecoveryDraftFromProject,
  autoRecoveryModeDetail,
  autoRecoveryModeLabel,
  autoRecoveryPresetPatch,
  autoRecoveryUpdateFromDraft,
  DEFAULT_AUTO_RECOVERY_LLM_TIMEOUT_MS,
  parseAutoRecoveryList,
} from './config-panel-auto-recovery-model.js';

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: 'mobile',
    repo: '/tmp/mobile',
    defaultBranch: 'main',
    flows: {},
    fixtures: {},
    templates: {},
    hooks: {},
    health: {},
    ci: {},
    defaults: {},
    ...overrides,
  } as ProjectConfig;
}

test('autoRecoveryDraftFromProject preserves defaults and configured values', () => {
  assert.deepEqual(autoRecoveryDraftFromProject(project()), {
    project: 'mobile',
    enabled: false,
    maxAttempts: 1,
    allowedStepsText: 'prepare, monitor, ci-watch',
    allowedCategoriesText: 'infra, timeout, env-drift, flake',
    disabledPatternsText: '',
    llmEnabled: false,
    llmDailyUsdCap: 0,
    llmTimeoutMs: DEFAULT_AUTO_RECOVERY_LLM_TIMEOUT_MS,
  });

  assert.deepEqual(
    autoRecoveryDraftFromProject(
      project({
        autoRecovery: {
          enabled: true,
          maxAttempts: 2,
          allowedSteps: ['prepare'],
          allowedCategories: ['infra'],
          disabledPatterns: ['pattern-a'],
          llm: { enabled: true, dailyUsdCap: 0.5, timeoutMs: 1234 },
        },
      }),
    ),
    {
      project: 'mobile',
      enabled: true,
      maxAttempts: 2,
      allowedStepsText: 'prepare',
      allowedCategoriesText: 'infra',
      disabledPatternsText: 'pattern-a',
      llmEnabled: true,
      llmDailyUsdCap: 0.5,
      llmTimeoutMs: 1234,
    },
  );
});

test('autoRecoveryPresetPatch mirrors component presets', () => {
  assert.deepEqual(autoRecoveryPresetPatch('off'), {
    enabled: false,
    maxAttempts: 0,
    llmEnabled: false,
    llmDailyUsdCap: 0,
  });
  assert.equal(autoRecoveryPresetPatch('safe-retry').llmEnabled, false);
  assert.equal(autoRecoveryPresetPatch('llm-assisted').llmEnabled, true);
  assert.equal(autoRecoveryPresetPatch('llm-assisted').llmDailyUsdCap, 0.25);
});

test('autoRecovery summary and update helpers preserve parsing behavior', () => {
  const draft = {
    ...autoRecoveryDraftFromProject(project()),
    enabled: true,
    maxAttempts: 3,
    allowedStepsText: 'prepare, monitor, ',
    allowedCategoriesText: 'infra, timeout',
    disabledPatternsText: 'one, two',
    llmEnabled: true,
    llmDailyUsdCap: 0.75,
  };

  assert.deepEqual(parseAutoRecoveryList(' one, two, ,three '), ['one', 'two', 'three']);
  assert.equal(
    autoRecoveryModeLabel(draft),
    'Gateway Intelligence enabled: replay + bounded LLM refinement',
  );
  assert.equal(
    autoRecoveryModeDetail(draft),
    '3 attempt(s) per step · steps: prepare, monitor · buckets: infra, timeout · LLM cap $0.75/day',
  );
  assert.deepEqual(autoRecoveryUpdateFromDraft(draft), {
    enabled: true,
    maxAttempts: 3,
    allowedSteps: ['prepare', 'monitor'],
    allowedCategories: ['infra', 'timeout'],
    disabledPatterns: ['one', 'two'],
    llm: {
      enabled: true,
      dailyUsdCap: 0.75,
      timeoutMs: DEFAULT_AUTO_RECOVERY_LLM_TIMEOUT_MS,
    },
  });
});
