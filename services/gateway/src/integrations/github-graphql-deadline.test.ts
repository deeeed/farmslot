import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import type { GhCommandContext } from './github-gh-command.js';

const observed: Array<AbortSignal | undefined> = [];
mock.module('./github-client.js', {
  namedExports: {
    githubRequestCacheKey: () => 'deadline-fixture',
  },
});
mock.module('./github-gh-command.js', {
  namedExports: {
    githubRestOp: async <T>(
      _host: string,
      _method: string,
      _path: string,
      _opts: unknown,
      ctx?: GhCommandContext,
    ): Promise<{ data: T }> => {
      observed.push(ctx?.signal);
      if (ctx?.signal) {
        await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Test fixture did not cancel')), 1000);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('gh request aborted'));
          };
          if (ctx.signal!.aborted) abort();
          else ctx.signal!.addEventListener('abort', abort, { once: true });
        });
      }
      return { data: { data: { value: 'ready' } } as unknown as T };
    },
  },
});
after(() => mock.restoreAll());
const { githubGraphQL, withGitHubQueryDeadline } = await import('./github-graphql.js');
const account = { host: 'github.com', token: 'synthetic-token', scope: 'fixture' };
test('a source deadline scopes its signal without leaking it into unscoped queries', async () => {
  const pending = withGitHubQueryDeadline(10, () => githubGraphQL('query { value }', {}, account));
  const rejection = assert.rejects(pending, /Source scan paused at its time limit/);
  assert.deepEqual(await githubGraphQL('query { value }', {}, account), { value: 'ready' });
  await rejection;
  assert.equal(observed[0]?.aborted, true);
  assert.equal(observed[1], undefined);
  assert.deepEqual(await githubGraphQL('query { value }', {}, account), { value: 'ready' });
  assert.equal(observed[2], undefined);
});
