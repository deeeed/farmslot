import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import type { GhRequestOpts } from './github-client.js';

const observed: Array<AbortSignal | undefined> = [];
mock.module('./github-client.js', {
  namedExports: {
    githubRequestCacheKey: () => 'deadline-fixture',
    ghRequest: async (_args: string[], opts?: GhRequestOpts) => {
      observed.push(opts?.signal);
      if (opts?.signal)
        await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Test fixture did not cancel')), 1000);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('gh request aborted'));
          };
          if (opts.signal!.aborted) abort();
          else opts.signal!.addEventListener('abort', abort, { once: true });
        });
      return { stdout: JSON.stringify({ data: { value: 'ready' } }), stderr: '' };
    },
  },
});
after(() => mock.restoreAll());
const { githubGraphQL, withGitHubQueryDeadline } = await import('./github-graphql.js');
const account = { host: 'github.com', token: 'synthetic-token', scope: 'fixture' };
test('a source deadline cancels its transport without changing concurrent unscoped callers', async () => {
  const pending = withGitHubQueryDeadline(10, () => githubGraphQL('query { value }', {}, account));
  const rejection = assert.rejects(pending, /Source scan paused at its time limit/);
  assert.deepEqual(await githubGraphQL('query { value }', {}, account), { value: 'ready' });
  await rejection;
  assert.equal(observed[0]?.aborted, true);
  assert.equal(observed[1], undefined);
  assert.deepEqual(await githubGraphQL('query { value }', {}, account), { value: 'ready' });
  assert.equal(observed[2], undefined);
});
