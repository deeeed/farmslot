import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prepareSkipReason,
  safeRecipeToolingProvenance,
  safeReferenceRepoProvenance,
} from './dispatch-lifecycle-steps.js';

test('static PR review skips prepare while explicit full-live review does not', () => {
  assert.equal(
    prepareSkipReason({ flowType: 'review-pr', reviewValidationDepth: 'static-code' }, false),
    'static-review',
  );
  assert.equal(
    prepareSkipReason({ flowType: 'review-pr', reviewValidationDepth: undefined }, false),
    'static-review',
  );
  assert.equal(
    prepareSkipReason({ flowType: 'review-pr', reviewValidationDepth: 'full-live' }, false),
    null,
  );
});

test('safeRecipeToolingProvenance keeps the version contract without arbitrary doctor data', () => {
  assert.deepEqual(
    safeRecipeToolingProvenance({
      schemaVersion: 1,
      protocolVersion: 'v1',
      runner_protocol_version: 1,
      status: 'pass',
      adapter: 'core',
      target: '/private/checkout',
      runner: {
        packageName: '@deeeed/metamask-harness',
        version: '0.24.0',
        packageSource: 'node_modules',
        installKind: 'global-install',
        executablePath: '/private/bin/mm-harness',
      },
      requiredChecks: { status: 'pass', total: 1, passed: 1, failed: [] },
      unbounded: { nested: 'discarded' },
    }),
    {
      schemaVersion: 1,
      protocolVersion: 'v1',
      runner_protocol_version: 1,
      status: 'pass',
      adapter: 'core',
      runner: {
        packageName: '@deeeed/metamask-harness',
        version: '0.24.0',
        packageSource: 'node_modules',
        installKind: 'global-install',
      },
      requiredChecks: { status: 'pass', total: 1, passed: 1, failed: [] },
    },
  );
});

test('safeReferenceRepoProvenance omits credential-bearing repository URLs', () => {
  assert.deepEqual(
    safeReferenceRepoProvenance({
      version: 1,
      recordedAt: '2026-07-29T21:00:00Z',
      repositories: [
        {
          name: 'harness',
          localName: 'metamask-harness',
          path: '/repo/metamask-harness',
          requestedUrl: 'https://token@example.com/repo.git',
          originUrl: 'https://user:secret@example.com/repo.git',
          requestedBranch: 'main',
          actualBranch: 'main',
          head: 'abc123',
          dirty: false,
          syncStatus: 'updated',
        },
      ],
    }),
    {
      version: 1,
      recordedAt: '2026-07-29T21:00:00Z',
      repositories: [
        {
          name: 'harness',
          localName: 'metamask-harness',
          path: '/repo/metamask-harness',
          requestedBranch: 'main',
          actualBranch: 'main',
          head: 'abc123',
          dirty: false,
          syncStatus: 'updated',
        },
      ],
    },
  );
});
