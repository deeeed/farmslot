import assert from 'node:assert/strict';
import test from 'node:test';

import { safeReferenceRepoProvenance } from './dispatch-lifecycle-steps.js';

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
