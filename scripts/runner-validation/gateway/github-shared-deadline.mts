import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  githubGraphQL,
  withGitHubQueryDeadline,
} from '../../../services/gateway/src/integrations/github-graphql.js';
const root = process.env.PR_PREVIEW_FIXTURE_DIR;
assert.ok(root);
const account = { host: 'github.com', token: 'synthetic-github-credential', scope: 'proof' };
const pending = withGitHubQueryDeadline(100, () =>
  githubGraphQL('query { deadlineSharedProof }', {}, account),
);
const rejected = assert.rejects(pending, /paused at its time limit/);
const result = await githubGraphQL('query { deadlineSharedProof }', {}, account);
await rejected;
assert.deepEqual(result, {
  deadlineSharedProof: 'ok',
  rateLimit: {
    cost: 1,
    remaining: 4999,
    resetAt: (result as { rateLimit: { resetAt: string } }).rateLimit.resetAt,
  },
});
const events = readFileSync(`${root}/requests.jsonl`, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.equal(
  events.filter((e) => e.kind === 'shared').length,
  1,
  'Both callers must share one real gh child',
);
console.log(JSON.stringify({ sharedChildSurvivedScopedAbort: true, upstreamCalls: 1 }));
