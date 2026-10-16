import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ReviewViewedFilesResult } from '@farmslot/protocol';

import type { GhRequestOpts } from '../integrations/github-client.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const binding = { host: 'github.com', token: 'fixture-only', scope: 'fixture-owner' };
const input = {
  pr: { host: 'github.com', repo: 'example/app', number: 42 },
  headSha: head,
  baseSha: base,
  account: { host: 'github.com', login: 'reviewer' },
  binding,
};
const calls: string[][] = [];
let pages: string[][];
let liveHead: string;
let actor: string;
let mutationErrors: boolean;
let moveBeforeMutation: boolean;
let mutationCount: number;
let saved: ReviewViewedFilesResult | undefined;
const reset = () => {
  pages = [['src/deleted.ts', 'src/renamed file.ts'], ['src/other.ts']];
  liveHead = head;
  actor = 'reviewer';
  mutationErrors = false;
  moveBeforeMutation = false;
  mutationCount = 0;
  calls.length = 0;
  saved = undefined;
};
mock.module('../integrations/github-client.js', {
  namedExports: {
    githubRequestCacheKey: () => 'viewed-fixture',
    ghRequest: async (args: string[], options: GhRequestOpts) => {
      assert.equal(
        options.account,
        binding,
        'Every observation and mutation uses the posting token',
      );
      calls.push(args);
      const fields = Object.fromEntries(
        args
          .filter((value) => /^[a-zA-Z0-9_]+=/.test(value))
          .map((value) => {
            const split = value.indexOf('=');
            return [value.slice(0, split), value.slice(split + 1)];
          }),
      );
      const pr = () => ({ id: 'PR_fixture', headRefOid: liveHead, baseRefOid: base });
      let data;
      if (fields.query.includes('markFileAsViewed')) {
        assert(options.signal, 'Mutation work has a deadline');
        mutationCount++;
        data = Object.fromEntries(
          Object.keys(fields)
            .filter((key) => /^path\d+$/.test(key))
            .map((key, index) => [
              key.replace('path', 'file'),
              mutationErrors && index === 1 ? null : { pullRequest: pr() },
            ]),
        );
      } else if (fields.query.includes('repository(')) {
        const index = Number(fields.cursor ?? 0);
        data = {
          viewer: { login: actor },
          repository: {
            pullRequest: {
              ...pr(),
              changedFiles: pages.flat().length,
              files: {
                nodes: pages[index].map((path) => ({ path })),
                pageInfo: {
                  hasNextPage: index < pages.length - 1,
                  endCursor: index < pages.length - 1 ? String(index + 1) : null,
                },
              },
            },
          },
        };
      } else {
        if (moveBeforeMutation) liveHead = 'c'.repeat(40);
        data = { node: pr() };
      }
      return {
        stdout: JSON.stringify({
          data,
          ...(mutationErrors && fields.query.includes('markFileAsViewed')
            ? { errors: [{ message: 'Forbidden path' }] }
            : {}),
        }),
        stderr: '',
      };
    },
  },
});
const { markReviewedFilesViewed } = await import('./viewed-files.js');
const save = async (result: ReviewViewedFilesResult) => {
  saved = structuredClone(result);
};

test('all paginated diff paths are marked using the exact posting account, independent of findings', async () => {
  reset();
  const result = await markReviewedFilesViewed(input, save);
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.markedPaths, pages.flat());
  assert.deepEqual(saved, result);
  assert.equal(mutationCount, 1);
  assert(calls.some((args) => args.includes('path1=src/renamed file.ts')));
  assert(calls.every((args) => !args.some((value) => value.includes('unmarkFile'))));
});

test('a stale head, changed head before marking, or foreign account creates no Viewed mutation', async () => {
  for (const scenario of ['stale', 'moved', 'account']) {
    reset();
    if (scenario === 'stale') liveHead = 'c'.repeat(40);
    if (scenario === 'moved') moveBeforeMutation = true;
    if (scenario === 'account') actor = 'other';
    const result = await markReviewedFilesViewed(input, save);
    assert.equal(result.state, 'failed');
    assert.equal(mutationCount, 0);
    assert.deepEqual(result.markedPaths, []);
    assert.deepEqual(saved, result);
  }
});

test('partial provider failures and diagnostic persistence failure stay best effort', async () => {
  reset();
  mutationErrors = true;
  const result = await markReviewedFilesViewed(input, save);
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.markedPaths, ['src/deleted.ts', 'src/other.ts']);
  assert.match(result.reason ?? '', /Forbidden path/);
  reset();
  const unretained = await markReviewedFilesViewed(input, async () => {
    throw new Error('Disk unavailable');
  });
  assert.equal(unretained.state, 'complete');
  assert.match(unretained.reason ?? '', /could not be retained/);
});
