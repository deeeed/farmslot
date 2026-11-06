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
let readListener: ((file: unknown) => void) | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...files,
    readFile: async (...args: Parameters<typeof files.readFile>) => {
      const contents = await files.readFile(...args);
      const notify = observed;
      observed = undefined;
      if (notify) setImmediate(notify);
      const listener = readListener;
      if (listener) setImmediate(() => listener(args[0]));
      return contents;
    },
  },
});
const { PRRuleStore } = await import('./store.js');
const { PRRuleService } = await import('./service.js');
const { PRReviewDispatcher } = await import('./dispatch.js');
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

test(
  'startup restores deferred admission, preserves other PRs and rereads automatically after retirement',
  { timeout: 5000 },
  async () => {
    const file = path.join(root, 'restart.json');
    const mixed: PRRuleStoreData = {
      ...replacement,
      intents: [
        ...replacement.intents,
        { ...replacement.intents[0], id: 'other-pending', pr: { ...pr, number: 43 } },
      ],
    };
    await files.writeFile(file, JSON.stringify(mixed));
    noteReviewWorkspaceRetirement(retired, true);
    let reads = 0;
    let ready!: () => void;
    const validated = new Promise<void>((resolve) => (ready = resolve));
    readListener = (f) => {
      if (String(f) === file && ++reads === 4) ready();
    };
    try {
      const first = await PRRuleStore.load(file);
      assert.throws(() => first.snapshot(), /cleanup/);
      const second = await PRRuleStore.load(file);
      assert.throws(() => second.snapshot(), /cleanup/);
      assert.doesNotThrow(
        () =>
          new PRRuleService(
            second,
            () => true,
            () => {},
          ),
        'deferred startup must not prevent cleanup service initialization',
      );
      const recoveryService = new PRRuleService(
        second,
        () => true,
        () => {},
      );
      assert.doesNotThrow(() => recoveryService.notifyChanges());
      const dispatcher = new PRReviewDispatcher(
        second,
        recoveryService,
        () => true,
        () => recoveryService.notifyChanges(),
      );
      dispatcher.start();
      try {
        await assert.rejects(dispatcher.reconcile(), /cleanup/);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.match(dispatcher.error ?? '', /cleanup/);
      } finally {
        dispatcher.stop();
      }
      await validated;
      assert.deepEqual(
        second.snapshotForRetention().intents.map((intent) => intent.id),
        ['other-pending'],
      );
      const latest = {
        ...mixed,
        intents: mixed.intents.map((intent) => ({ ...intent, headSha: 'b'.repeat(40) })),
      };
      await files.writeFile(file, JSON.stringify(latest));
      let rereads = 0;
      let settled!: () => void;
      const published = new Promise<void>((resolve) => (settled = resolve));
      readListener = (f) => {
        if (String(f) === file && ++rereads === 2) settled();
      };
      let cleanup = false;
      await reclaimReviewWorkspaceStorage(async () => {
        cleanup = true;
        noteReviewWorkspaceRetirement(
          {
            ...retired,
            reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
          },
          true,
        );
        return [];
      });
      assert.equal(cleanup, true);
      await published;
      assert.deepEqual(first.snapshot().intents, latest.intents);
      assert.deepEqual(second.snapshot().intents, latest.intents);
    } finally {
      readListener = undefined;
      noteReviewWorkspaceRetirement(
        {
          ...retired,
          reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
        },
        true,
      );
    }
  },
);

test(
  'detached startup reload retains source failure diagnostics and recovers on a valid replacement',
  { timeout: 5000 },
  async () => {
    const file = path.join(root, 'restart-invalid.json');
    await files.writeFile(file, JSON.stringify(replacement));
    noteReviewWorkspaceRetirement(retired, true);
    let reads = 0;
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => (ready = resolve));
    readListener = (f) => {
      if (String(f) === file && ++reads === 2) ready();
    };
    try {
      const store = await PRRuleStore.load(file);
      assert.throws(() => store.snapshot(), /cleanup/);
      await waiting;
      await files.writeFile(file, '{invalid');
      let failed!: () => void;
      const failure = new Promise<void>((resolve) => (failed = resolve));
      readListener = (f) => {
        if (String(f) === file) failed();
      };
      await reclaimReviewWorkspaceStorage(async () => {
        noteReviewWorkspaceRetirement(
          {
            ...retired,
            reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
          },
          true,
        );
        return [];
      });
      await failure;
      assert.throws(() => store.snapshot(), /source is unavailable.*:/);
      assert.throws(() => store.snapshotForRetention(), /source is unavailable/);
      await files.writeFile(file, JSON.stringify(replacement));
      await store.reloadFromFile();
      assert.deepEqual(store.snapshot().intents, replacement.intents);
    } finally {
      readListener = undefined;
      noteReviewWorkspaceRetirement(
        {
          ...retired,
          reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
        },
        true,
      );
    }
  },
);
