// Deterministic read-only GitHub CLI boundary for the isolated identity recipe.
// The production RPC, persistence, collectors and background services remain real.
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write('isolated-proof-credential\n');
} else if (args[0] === 'api') {
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const pr = {
    id: 'proof-pr',
    number: 1,
    title: 'Identity proof',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'contributor' },
    headRefOid: 'a'.repeat(40),
    baseRefOid: 'b'.repeat(40),
    baseRefName: 'main',
    headRefName: 'proof',
    repository: { nameWithOwner: 'example/proof' },
    headRepository: { nameWithOwner: 'example/proof', viewerPermission: 'WRITE' },
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    viewerLatestReview: null,
    viewerLatestReviewRequest: null,
    labels: page,
    url: 'https://github.com/example/proof/pull/1',
  };
  const query = args.find((arg) => arg.startsWith('query=')) ?? '';
  let body;
  if (!args.includes('graphql')) body = { login: 'reader' };
  else {
    let data;
    if (query.includes('pullRequests('))
      data = { repository: { pullRequests: { ...page, nodes: [pr] } } };
    else if (query.includes('repository(owner:')) data = { repository: { pullRequest: pr } };
    else if (query.includes('commits('))
      data = {
        node: {
          headRefOid: pr.headRefOid,
          commits: {
            nodes: [{ commit: { oid: pr.headRefOid, statusCheckRollup: { contexts: page } } }],
          },
        },
      };
    else if (query.includes('node(id:'))
      data = {
        node: { ...pr, reviews: page, reviewThreads: page, comments: page, projectItems: page },
      };
    else throw new Error('Unexpected GitHub proof query');
    body = {
      data: {
        ...data,
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    };
  }
  if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\n\r\n');
  process.stdout.write(JSON.stringify(body));
} else {
  throw new Error('Identity proof only permits GitHub authentication lookup and read requests');
}
