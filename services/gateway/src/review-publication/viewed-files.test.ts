import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { isRecord, type ReviewViewedFilesResult } from '@farmslot/protocol';

import { rejectMutationRateLimit } from '../../../../scripts/runner-validation/review-provider-fixture.cjs';
import { startGitHubFixture } from '../integrations/github-test-fixtures.js';

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
let moveAfterFirstMutation: boolean;
let mutationCount: number;
let saved: ReviewViewedFilesResult | undefined;
const reset = () => {
  pages = [['src/deleted.ts', 'src/renamed file.ts'], ['src/other.ts']];
  liveHead = head;
  actor = 'reviewer';
  mutationErrors = false;
  moveBeforeMutation = false;
  moveAfterFirstMutation = false;
  mutationCount = 0;
  calls.length = 0;
  saved = undefined;
};
// GitHub GraphQL through the real githubGraphQL client; the fixture validates like GitHub.
const fixture = await startGitHubFixture((request) => {
  assert.equal(
    request.headers.authorization,
    `token ${binding.token}`,
    'Every observation and mutation uses the posting token',
  );
  const body = isRecord(request.json) ? request.json : {};
  const doc = typeof body.query === 'string' ? body.query : '';
  const variables = isRecord(body.variables) ? body.variables : {};
  const invalid = rejectMutationRateLimit(doc);
  if (invalid) return { body: invalid };
  const args = [...Object.entries(variables).map(([k, v]) => `${k}=${String(v)}`), doc];
  calls.push(args);
  const pr = () => ({ id: 'PR_fixture', headRefOid: liveHead, baseRefOid: base });
  if (doc.includes('markFileAsViewed')) {
    mutationCount++;
    const data: Record<string, unknown> = {};
    let idx = 0;
    for (const key of Object.keys(variables)) {
      if (/^path\d+$/.test(key)) {
        data[key.replace('path', 'file')] =
          mutationErrors && idx === 1 ? null : { pullRequest: pr() };
        idx++;
      }
    }
    if (moveAfterFirstMutation && mutationCount === 1) liveHead = 'c'.repeat(40);
    return { body: { data } };
  } else if (doc.includes('repository(')) {
    const index = Number(variables.cursor ?? 0);
    return {
      body: {
        data: {
          viewer: { login: actor },
          repository: {
            pullRequest: {
              ...pr(),
              changedFiles: pages.flat().length,
              files: {
                nodes: pages[index].map((p) => ({ path: p })),
                pageInfo: {
                  hasNextPage: index < pages.length - 1,
                  endCursor: index < pages.length - 1 ? String(index + 1) : null,
                },
              },
            },
          },
        },
      },
    };
  } else {
    if (moveBeforeMutation) liveHead = 'c'.repeat(40);
    return { body: { data: { node: pr() } } };
  }
});
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;
after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
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
  assert.match(result.reason ?? '', /GitHub did not confirm every Viewed mutation/);
  reset();
  const unretained = await markReviewedFilesViewed(input, async () => {
    throw new Error('Disk unavailable');
  });
  assert.equal(unretained.state, 'complete');
  assert.match(unretained.reason ?? '', /could not be retained/);
});

test('large diffs use bounded batches and stop before marking a newer head', async () => {
  for (const advanced of [false, true]) {
    reset();
    pages = [Array.from({ length: 45 }, (_, i) => `src/file-${i}.ts`)];
    moveAfterFirstMutation = advanced;
    const result = await markReviewedFilesViewed(input, save);
    assert.equal(result.state, advanced ? 'partial' : 'complete');
    assert.equal(mutationCount, advanced ? 1 : 3);
    assert.deepEqual(result.markedPaths, pages[0].slice(0, advanced ? 20 : 45));
    assert.deepEqual(saved, result);
  }
});
