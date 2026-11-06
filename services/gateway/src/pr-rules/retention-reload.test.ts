import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as files from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  noteReviewWorkspaceRetirement,
  reclaimReviewWorkspaceStorage,
} from '../review-workspaces/storage-use.js';

import type { PRRuleStoreData } from './store.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'review-reload-retirement-'));
after(() => files.rm(root, { recursive: true, force: true }));
let observed: (() => void) | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...files,
    readFile: async (...args: Parameters<typeof files.readFile>) => {
      const contents = await files.readFile(...args);
      const notify = observed;
      observed = undefined;
      if (notify) setImmediate(notify);
      return contents;
    },
  },
});
const { PRRuleStore } = await import('./store.js');
const pr = { host: 'github.com', repo: 'example/app', number: 42 };
const replacement: PRRuleStoreData = {
  version: 1,
  teams: [],
  rules: [],
  intents: [
    {
      id: 'external-review',
      pr,
      headSha: 'a'.repeat(40),
      reviewProfile: 'standard',
      status: 'queued',
      contributions: [],
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    },
  ],
};
const retired: Pick<Run, 'id' | 'ticketOrPr' | 'reviewWorkspace'> = {
  id: 'retiring-reload',
  ticketOrPr: 'example/app#42',
  reviewWorkspace: {
    workspaceId: 'workspace',
    machine: 'node',
    executionNodeId: 'node',
    checkoutPath: '/owned/source',
    taskPath: '/owned/task',
    artifactPath: '/owned/task/artifacts',
    retirement: { id: 'retirement', startedAt: '2026-11-06T00:00:00.000Z', pr },
  },
};
for (const malformed of [false, true])
  test(`valid reload waits outside cleanup and recovers automatically after ${malformed ? 'malformed' : 'healthy'} source`, async () => {
    const file = path.join(root, String(malformed) + '.json');
    const store = await PRRuleStore.load(file);
    if (malformed) {
      await files.writeFile(file, '{invalid');
      await assert.rejects(store.reloadFromFile());
      assert.throws(() => store.snapshot(), /source is unavailable/);
    }
    await files.writeFile(file, JSON.stringify(replacement));
    noteReviewWorkspaceRetirement(retired);
    const ready = new Promise<void>((resolve) => (observed = resolve));
    let published = false;
    let failure: unknown;
    const reload = store.reloadFromFile().then(
      () => {
        published = true;
      },
      (error) => {
        failure = error;
      },
    );
    try {
      await ready;
      assert.equal(published, false);
      assert.equal(failure, undefined);
      assert.throws(() => store.snapshot(), malformed ? /source is unavailable/ : /cleanup/);
      assert.deepEqual(
        store.snapshotForRetention().intents,
        [],
        'only last accepted intents count while replacement is unadmitted',
      );
      let reclaimed = false;
      await reclaimReviewWorkspaceStorage(async () => {
        reclaimed = true;
        noteReviewWorkspaceRetirement(
          {
            ...retired,
            reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
          },
          true,
        );
        return [];
      });
      assert.equal(reclaimed, true, 'waiting reload does not hold the storage reader fence');
      await reload;
      assert.equal(failure, undefined);
      assert.equal(published, true);
      assert.deepEqual(store.snapshot().intents, replacement.intents);
    } finally {
      noteReviewWorkspaceRetirement(
        {
          ...retired,
          reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
        },
        true,
      );
      await reload;
    }
  });
