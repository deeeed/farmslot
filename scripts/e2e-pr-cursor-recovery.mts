import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import { resolvePRSourceAccount } from '../services/gateway/src/pr-monitoring/github-account.js';
import {
  githubGraphQL,
  type GitHubPage,
} from '../services/gateway/src/integrations/github-graphql.js';
import { GitHubCursorError } from '../services/gateway/src/integrations/github-errors.js';
import {
  PRSourceCheckpoints,
  prSourceCheckpointScope,
  type PRSourceTraversal,
} from '../services/gateway/src/pr-rules/source-checkpoints.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const repo = process.env.CHECKPOINT_REPO;
const login = process.env.CHECKPOINT_GITHUB_LOGIN;
assert(repo && login);
const directory = await mkdtemp(join(tmpdir(), 'pr-live-cursor-'));
try {
  const account = await resolvePRSourceAccount({ host: 'github.com', login }, 'cursor-validation');
  const store = await PRSourceCheckpoints.load(join(directory, 'checkpoints.json'));
  const scope = prSourceCheckpointScope(
    { id: 'team', ownerId: 'cursor-validation', revision: 1 },
    { id: 'rule', ownerId: 'cursor-validation', revision: 1 },
    account,
  );
  const partial = await store.read(scope, 1, async (traversal) => {
    try {
      await traversal.pages('repository', async () => ({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: 'intentionally-invalid-cursor' },
      }));
      assert.fail('Setup must stop before requesting the invalid cursor');
    } catch (error) {
      assert.match(String(error), /paused/);
      return {
        subjects: [],
        complete: false,
        errors: ['Validation setup: invalid persisted cursor'],
        ignoredItems: 0,
      };
    }
  });
  const [owner, name] = repo.split('/');
  let rejected = false;
  const collect = async (traversal: PRSourceTraversal) => {
    try {
      const rows = await traversal.pages('repository', async (cursor) => {
        const data = await githubGraphQL<{
          repository: { pullRequests: GitHubPage<{ id: string }> };
        }>(
          'query($owner:String!,$name:String!,$cursor:String) { repository(owner:$owner,name:$name) { pullRequests(first:100,after:$cursor,states:OPEN) { nodes { id } pageInfo { hasNextPage endCursor } } } }',
          { owner, name, cursor },
          account,
        );
        return data.repository.pullRequests;
      });
      return { subjects: [], complete: true, errors: [], ignoredItems: rows.length };
    } catch (error) {
      assert(
        error instanceof GitHubCursorError,
        `Real GitHub cursor rejection must survive structured HTTP classification: ${String(error)}`,
      );
      rejected = true;
      return { subjects: [], complete: false, errors: [error.message], ignoredItems: 0 };
    }
  };
  const invalid = await store.read(scope, 5, collect);
  assert(rejected && !invalid.complete);
  assert.equal(store.connection(partial.progress.id, 'repository'), undefined);
  const restored = await (
    await PRSourceCheckpoints.load(join(directory, 'checkpoints.json'))
  ).read(scope, 5, collect);
  assert(restored.complete && restored.ignoredItems > 0);
  console.log(
    JSON.stringify({
      passed: true,
      providerRejectedCursor: true,
      restartedFromFirstPage: true,
      rows: restored.ignoredItems,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
