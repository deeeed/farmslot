import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import { isListReadOutage, prList, type PRListFetchResult } from '../pr.js';

import { resetPRListCacheForTests, servePRList } from './list-cache.js';

function pr(n: number, project: string): PRStatus {
  return { pr: n, repo: 'org/app', title: `PR ${n}`, project, prState: 'OPEN' } as PRStatus;
}

test('project-scoped pr.list filters the warm copy, or rediscovers per project once that copy is capped', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-list-'));
  const previous = process.env.FARMSLOT_DIR;
  process.env.FARMSLOT_DIR = dir;
  resetPRListCacheForTests();
  try {
    const calls: Array<{ force?: boolean; project?: string }> = [];
    const fetchList = async (opts: { force?: boolean; project?: string }) => {
      calls.push(opts);
      const result: PRListFetchResult = {
        prs: [pr(3, 'b'), pr(4, 'a')],
        truncated: false,
        failed: [],
      };
      return result;
    };
    await servePRList(async () => ({
      prs: [pr(1, 'a'), pr(2, 'b')],
      truncated: false,
      failed: [],
    }));
    const filtered = await prList({ project: 'b' }, fetchList);
    assert.deepEqual(calls, [], 'a complete warm copy is filtered, not refetched');
    assert.deepEqual(
      filtered.prs.map((p) => p.pr),
      [2],
    );

    resetPRListCacheForTests();
    await servePRList(async () => ({ prs: [pr(1, 'a'), pr(2, 'b')], truncated: true, failed: [] }));
    const rediscovered = await prList({ project: 'b' }, fetchList);
    assert.deepEqual(calls, [{ project: 'b', force: undefined }]);
    assert.deepEqual(
      rediscovered.prs.map((p) => p.pr),
      [3],
      'rediscovery result is filtered by project too',
    );
    assert.equal(rediscovered.refreshing, false);
  } finally {
    resetPRListCacheForTests();
    if (previous === undefined) delete process.env.FARMSLOT_DIR;
    else process.env.FARMSLOT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fetch is an outage only when nothing could be read and it was not one deleted PR', () => {
  assert.equal(isListReadOutage({ candidates: 0, failed: 0, gone: 0 }), false, 'empty farm');
  assert.equal(isListReadOutage({ candidates: 1, failed: 0, gone: 1 }), false, 'one deleted PR');
  assert.equal(
    isListReadOutage({ candidates: 1, failed: 1, gone: 0 }),
    true,
    'lone transient failure',
  );
  assert.equal(
    isListReadOutage({ candidates: 3, failed: 0, gone: 3 }),
    true,
    'mass 404 is lost access',
  );
  assert.equal(
    isListReadOutage({ candidates: 3, failed: 1, gone: 2 }),
    true,
    'nothing read at all',
  );
  assert.equal(
    isListReadOutage({ candidates: 3, failed: 2, gone: 0 }),
    false,
    'one read succeeded',
  );
});
