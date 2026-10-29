import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, mock, test } from 'node:test';

import type {
  PRForSlotParams,
  PRForSlotResult,
  RunnerModelCatalogResult,
} from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  RESOURCE_REREAD_INTERVAL_MS,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../../core/method-error.js';
import * as fleet from '../../fleet/state.js';
import * as githubClient from '../../integrations/github-client.js';
import { readWithResourceState, resourceRevisions } from '../../resources/revisions.js';
import { readRunnerModelCatalog } from '../../runners/model-catalog.js';

const dir = mkdtempSync(path.join(tmpdir(), 'pr-detail-'));
const previousDir = process.env.FARMSLOT_DIR;
process.env.FARMSLOT_DIR = dir;

const managed = { legacyInterest: false };
const calls: string[][] = [];
const github = {
  title: 'First title',
  prView: 'ok' as 'ok' | 'gone' | 'down',
  discoveryDown: false,
  threadsMissing: false,
  threads: [
    {
      id: 'T1',
      isResolved: false,
      isOutdated: false,
      path: 'src/a.ts',
      line: 3,
      comments: {
        nodes: [
          {
            databaseId: 5,
            body: 'Please rename',
            author: { login: 'bot' },
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        ],
      },
    },
  ],
  branches: { 'feat/a': { pr: 7, baseRef: 'main' } } as Record<
    string,
    { pr: number; baseRef: string }
  >,
};
const slot = {
  slot: 's1',
  project: 'app',
  branch: 'main',
  enabled: true,
  agent: 'working',
  session: 's1',
};
const project = {
  name: 'app',
  defaultBranch: 'main',
  ci: { repo: 'org/app', checkGroups: [], botPatterns: [] },
};

function respond(args: string[]): string {
  const [command, sub] = args;
  if (command === 'pr' && sub === 'view') {
    if (github.prView === 'gone') throw new Error('HTTP 404: Not Found (https://api.github.com)');
    if (github.prView === 'down') throw new Error('connect ECONNREFUSED /tmp/gh.sock');
    return `OPEN\tMERGEABLE\tCLEAN\tAPPROVED\tfeat/a\t2026-01-01\t2026-01-02\t\t\t${github.title}\nauthor\n`;
  }
  if (command === 'pr' && sub === 'list') {
    if (github.discoveryDown) throw new Error('gh: connection reset');
    const found = github.branches[args[args.indexOf('--head') + 1]];
    return found ? JSON.stringify(found) : '';
  }
  if (command === 'api' && sub === 'user') return 'reviewer\n';
  if (command === 'api' && sub === 'graphql') {
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (!query.includes('updatedAt') || query.includes('mutation')) return '';
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: github.threadsMissing ? null : { reviewThreads: { nodes: github.threads } },
        },
      },
    });
  }
  const pull = /^repos\/org\/app\/pulls\/(\d+)$/.exec(sub ?? '');
  if (command === 'api' && pull) {
    const [head, found] =
      Object.entries(github.branches).find(([, entry]) => entry.pr === Number(pull[1])) ?? [];
    return JSON.stringify({ state: 'open', head, base: found?.baseRef });
  }
  return '';
}

mock.module('../../integrations/github-client.js', {
  namedExports: {
    ...githubClient,
    ghRequest: async (args: string[]) => {
      calls.push(args);
      return { stdout: respond(args), stderr: '' };
    },
  },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({ slots: [{ ...slot }] }),
    loadProjectConfig: async (name: string) => (name === project.name ? project : null),
    loadProjectConfigs: async () => [project],
  },
});

const {
  prForSlot,
  prForSlotObservation,
  prList,
  prStatusObservation,
  readPRForSlot,
  readPRStatus,
} = await import('../pr.js');
const { resetPRListCacheForTests } = await import('./list-cache.js');
const { prResolveThread, prReviewComments, prReviewThreadsObservation } =
  await import('./review-comments.js');
const { getPRRawData } = await import('./raw-cache.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof GatewayMethodError, String(error));
  assert.equal(error.code, expected);
  return true;
};

after(() => {
  resourceRevisions.setPublisher(() => undefined);
  resetPRListCacheForTests();
  prStatusObservation.resetForTests();
  prForSlotObservation.resetForTests();
  prReviewThreadsObservation.resetForTests();
  if (previousDir === undefined) delete process.env.FARMSLOT_DIR;
  else process.env.FARMSLOT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('gateway-owned PR detail observations', { concurrency: 1 }, () => {
  test('pr.status reuses a PR read another owner retained and adopts its newer reads', async () => {
    await getPRRawData('org/app', 7);
    const before = calls.length;
    const first = await readPRStatus({ pr: 7, project: 'app' }, managed);
    assert.equal(calls.length, before, 'the retained read is not fetched a second time');
    assert.equal(first.pr.title, 'First title');
    assert.equal(first.observation?.status, 'ready');
    const key = prStatusObservation.resourceKey({ pr: 7, project: 'app' });
    assert.equal(key.queryId, 'pr.status:{"pr":7,"project":"app"}');
    const revision = resourceRevisions.revision(key);
    github.title = 'Second title';
    await settle();
    // Active CI monitoring keeps its own forced schedule; its read updates the observation.
    await getPRRawData('org/app', 7, true);
    assert.equal(resourceRevisions.revision(key), revision + 1);
    const second = await readPRStatus({ pr: 7, project: 'app' }, managed);
    assert.equal(second.pr.title, 'Second title');
    assert.ok(second.observation!.observedAt! > first.observation!.observedAt!);
    await settle();
    // The same PR bytes with a newer fetch time are not a change for observers.
    await getPRRawData('org/app', 7, true);
    assert.equal(resourceRevisions.revision(key), revision + 1);
    const third = await readPRStatus({ pr: 7, project: 'app' }, managed);
    assert.ok(third.observation!.observedAt! > second.observation!.observedAt!);
  });

  test('managed pr.status never turns absent or unreadable PRs into rows; released readers keep theirs', async () => {
    github.title = 'Forced title';
    const forced = await readPRStatus({ pr: 7, project: 'app', force: true });
    assert.equal(forced.pr.title, 'Forced title');
    await assert.rejects(readPRStatus({ pr: 7 }, managed), code('INVALID_PARAMS'));
    await assert.rejects(readPRStatus({ pr: 7 }), /Project is required/, 'the released CLI error');

    github.prView = 'gone';
    await assert.rejects(readPRStatus({ pr: 8, project: 'app' }, managed), code('NOT_FOUND'));
    assert.equal((await readPRStatus({ pr: 8, project: 'app' })).pr.title, 'PR #8');
    const forcedGone = await readPRStatus({ pr: 10, project: 'app', force: true });
    assert.equal(forcedGone.pr.title, 'PR #10', 'a released forced check keeps its placeholder');
    assert.equal(
      calls.filter((args) => args[1] === 'view' && args[2] === '10').length,
      1,
      'the released reply reuses the forced attempt instead of forcing again',
    );

    github.prView = 'down';
    await assert.rejects(
      readPRStatus({ pr: 9, project: 'app' }, managed),
      code('UPSTREAM_UNAVAILABLE'),
    );
    github.prView = 'ok';
    const before = calls.length;
    assert.equal((await readPRStatus({ pr: 9, project: 'app' })).pr.title, 'PR #9');
    await assert.rejects(readPRStatus({ pr: 9, project: 'app' }, managed), /no state/);
    assert.equal(calls.length, before, 'a cold failure is not retried within the cadence');
  });

  test('pr.forSlot answers local slots locally and observes GitHub for the current branch', async () => {
    slot.branch = 'main';
    let before = calls.length;
    assert.deepEqual(await readPRForSlot({ slotId: 's1' }), {
      pr: null,
      repo: null,
      baseRef: 'main',
      source: 'local',
    });
    assert.equal(calls.length, before, 'a default-branch slot needs no GitHub lookup');

    slot.branch = 'feat/a';
    const found = await readPRForSlot({ slotId: 's1' }, managed);
    assert.deepEqual(
      { pr: found.pr, repo: found.repo, baseRef: found.baseRef, status: found.observation?.status },
      { pr: 7, repo: 'org/app', baseRef: 'main', status: 'ready' },
    );
    assert.equal(
      prForSlotObservation.resourceKey({ slotId: 's1' }).queryId,
      'pr.forSlot:{"slotId":"s1"}',
    );
    before = calls.length;
    await readPRForSlot({ slotId: 's1' }, managed);
    assert.equal(calls.length, before, 'a warm managed read shares the retained lookup');

    slot.branch = 'feat/b';
    github.branches['feat/b'] = { pr: 11, baseRef: 'release' };
    const moved = await readPRForSlot({ slotId: 's1' }, managed);
    assert.deepEqual([moved.pr, moved.baseRef], [11, 'release']);

    slot.branch = 'feat/c';
    github.discoveryDown = true;
    await assert.rejects(
      readPRForSlot({ slotId: 's1' }, managed),
      /connection reset/,
      'an unreadable lookup is not reported as "no PR"',
    );
    assert.deepEqual(
      await readPRForSlot({ slotId: 's1' }),
      { pr: null, repo: 'org/app', baseRef: 'main' },
      'a released reader keeps the tolerant lookup',
    );
    assert.deepEqual(
      await prForSlot({ slotId: 's1' }),
      { pr: null, repo: 'org/app', baseRef: 'main' },
      'the explicit fleet summary keeps its tolerant lookup',
    );
    slot.branch = 'feat/b';
    const retained = await readPRForSlot({ slotId: 's1' }, managed);
    assert.equal(retained.pr, 11);
    github.discoveryDown = false;
  });

  test('review threads are one shared observation that a completed command re-collects', async () => {
    const first = await prReviewComments({ pr: 7, repo: 'org/app' }, managed);
    assert.equal(first.currentUser, 'reviewer');
    assert.equal(first.threads[0]?.resolved, false);
    assert.equal(first.observation?.status, 'ready');
    const key = prReviewThreadsObservation.resourceKey({ pr: 7, repo: 'org/app' });
    assert.equal(key.queryId, 'pr.reviewComments:{"pr":7,"repo":"org/app"}');
    const revision = resourceRevisions.revision(key);
    const before = calls.length;
    await prReviewComments({ pr: 7, repo: 'org/app' }, managed);
    assert.equal(calls.length, before, 'warm managed reads do not reach GitHub');

    github.threads[0].isResolved = true;
    await prResolveThread({ repo: 'org/app', threadId: 'T1', resolved: true });
    const reload = await prReviewComments({ pr: 7, repo: 'org/app' }, { legacyClientId: 'c1' });
    assert.equal(reload.threads[0]?.resolved, true, 'a reload waits for the command re-collection');
    await settle();
    assert.ok(resourceRevisions.revision(key) > revision, 'the command completion published');
    assert.ok(
      calls.slice(before).some((args) => args[0] === 'pr' && args[1] === 'view'),
      'the observed status of the same PR is re-collected too',
    );
    const after = await prReviewComments({ pr: 7, repo: 'org/app' }, managed);
    assert.equal(after.threads[0]?.resolved, true);

    github.threadsMissing = true;
    await assert.rejects(prReviewComments({ pr: 99, repo: 'org/app' }, managed), code('NOT_FOUND'));
    assert.deepEqual(
      await prReviewComments({ pr: 99, repo: 'org/app' }),
      { threads: [], currentUser: 'reviewer' },
      'a released reader keeps the empty list',
    );
    github.threadsMissing = false;
  });
});

describe('legacy pr.list discovery', { concurrency: 1 }, () => {
  test('an unreadable slot discovery stays a readable list whose observation reports it', async () => {
    slot.slot = 's-list';
    slot.branch = 'feat/unreadable';
    github.discoveryDown = true;
    try {
      const listed = await prList({ project: 'app' });
      assert.deepEqual(listed.prs, [], 'released readers keep the empty list');
      assert.equal(listed.observation?.status, 'stale');
      assert.equal(listed.observation?.error?.code, 'UPSTREAM_INCOMPLETE');
    } finally {
      github.discoveryDown = false;
    }
  });
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert(Date.now() < deadline, 'Condition did not arrive');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The protocol cache reading the real gateway handlers, stamped by the gateway's revisions. */
function cacheThrough(handlers: Record<string, (params: unknown) => Promise<unknown>>) {
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'none',
    scope: { gatewayUrl: 'ws://pr-detail.invalid' },
    authority: { roles: [], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: {
        version: 1,
        epoch: resourceRevisions.epoch,
        versionLists: false,
        upstreamObservers: { version: 1, methods: ['pr.forSlot', 'runner.modelCatalog'] },
      },
    },
  };
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: () => () => undefined,
    onResourceChanged(listener) {
      resourceRevisions.setPublisher(listener);
      return () => resourceRevisions.setPublisher(() => undefined);
    },
    resynchronize: () => assert.fail('No epoch change'),
    async request<T>(...[method, params]: Parameters<ResourceCacheTransport['request']>) {
      const { payload, resourceState } = await readWithResourceState(
        resourceQuery(method, params).dependencies,
        () => handlers[method]!(params),
      );
      return { data: payload as T, resourceState };
    },
    replaceObservers: async (params) => ({
      version: 1,
      sequence: params.sequence,
      applied: true,
    }),
  };
  return createGatewayResourceCache({ transport });
}

describe('observations through the shared cache', { concurrency: 1 }, () => {
  const slotHandler = {
    'pr.forSlot': (params: unknown) => readPRForSlot(params as PRForSlotParams, managed),
  };

  test('a slot moving to its default branch replaces its PR with an explicit local answer', async (t) => {
    slot.slot = 's-cache';
    slot.branch = 'feat/a';
    const cache = cacheThrough(slotHandler);
    const query = resourceQuery<PRForSlotResult>('pr.forSlot', { slotId: 's-cache' });
    const stop = cache.observe(query, () => undefined);
    try {
      await until(() => cache.read(query).status === 'ready');
      assert.equal(cache.read(query).data?.pr, 7);
      assert.equal(cache.read(query).sourceObservation?.status, 'ready');
      slot.branch = 'main';
      // Automatic rereads of farm slot keys are paced; this change comes a full interval later.
      const now = performance.now.bind(performance);
      t.mock.method(performance, 'now', () => now() + RESOURCE_REREAD_INTERVAL_MS.slots!);
      resourceRevisions.advance({ family: 'slots', scope: 'farm' });
      await until(() => cache.read(query).data?.pr === null);
      const local = cache.read(query);
      assert.equal(local.status, 'ready');
      assert.equal(local.error, undefined, 'the old PR is not retained behind an error');
      assert.equal(local.sourceObservation, undefined, 'no upstream source time is invented');
      assert.deepEqual(local.data, { pr: null, repo: null, baseRef: 'main', source: 'local' });
      // The slot view binds review threads only from a current PR and repository.
      assert.equal(Boolean(local.data?.pr && local.data.repo), false);
    } finally {
      stop();
      await cache.dispose();
    }
  });

  test('a cold default-branch slot is a ready local answer', async () => {
    slot.slot = 's-cold';
    slot.branch = 'main';
    const cache = cacheThrough(slotHandler);
    const query = resourceQuery<PRForSlotResult>('pr.forSlot', { slotId: 's-cold' });
    const stop = cache.observe(query, () => undefined);
    try {
      await until(() => cache.read(query).status !== 'loading');
      const state = cache.read(query);
      assert.equal(state.status, 'ready');
      assert.equal(state.error, undefined);
      assert.equal(state.data?.source, 'local');
    } finally {
      stop();
      await cache.dispose();
    }
  });

  test('an unsupported catalog is an explicit answer; a collected source still needs its observation', async () => {
    const cache = cacheThrough({
      'runner.modelCatalog': async (params) => {
        const { runner } = params as { runner: string };
        return runner === 'claude'
          ? readRunnerModelCatalog(runner, undefined)
          : ({ runner, status: 'ready', source: 'structured-file', models: [] } as const);
      },
    });
    const unsupported = resourceQuery<RunnerModelCatalogResult>('runner.modelCatalog', {
      runner: 'claude',
    });
    const collected = resourceQuery<RunnerModelCatalogResult>('runner.modelCatalog', {
      runner: 'cursor',
    });
    const stops = [unsupported, collected].map((query) => cache.observe(query, () => undefined));
    try {
      await until(() =>
        [unsupported, collected].every((query) => cache.read(query).status !== 'loading'),
      );
      const catalog = cache.read(unsupported);
      assert.equal(catalog.status, 'ready');
      assert.equal(catalog.error, undefined);
      assert.equal(catalog.sourceObservation, undefined);
      assert.equal(catalog.data?.status, 'unsupported');
      assert.equal(cache.read(collected).error?.code, 'RESOURCE_SOURCE_STATE_MISSING');
    } finally {
      for (const stop of stops) stop();
      await cache.dispose();
    }
  });
});
