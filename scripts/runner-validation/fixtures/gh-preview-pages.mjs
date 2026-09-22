// Controlled GitHub CLI transport for the isolated gateway recipe. Never calls gh/network.
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2),
  root = process.env.PR_PREVIEW_FIXTURE_DIR;
if (!root) throw new Error('Fixture directory required');
const phase = readFileSync(`${root}/phase`, 'utf8').trim();
const log = (event) => appendFileSync(`${root}/requests.jsonl`, JSON.stringify(event) + '\n');
const emit = (value) =>
  process.stdout.write(
    (args.includes('--include')
      ? 'HTTP/2 200 OK\r\ncontent-type: application/json\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 4999\r\n\r\n'
      : '') + JSON.stringify(value),
  );
const field = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const page = (nodes, cursor = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const pr = (number) => ({
  id: `pr-${number}`,
  number,
  title: `Fixture ${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'a'.repeat(40),
  baseRefOid: 'b'.repeat(40),
  baseRefName: 'main',
  headRefName: 'feature',
  author: { login: 'author' },
  repository: { nameWithOwner: 'fixture/repo' },
  labels: page([]),
  viewerLatestReview: null,
  viewerLatestReviewRequest: null,
});
if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write('synthetic-github-credential');
} else if (args[0] === 'api' && args.includes('user')) {
  emit({ login: 'fixture-user' });
} else if (args[0] === 'api' && args.includes('graphql')) {
  const query = field('query') ?? '',
    cursor = field('cursor') ?? null;
  const quota = { cost: 1, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() };
  if (query.includes('deadlineSharedProof')) {
    log({ kind: 'shared' });
    await new Promise((r) => setTimeout(r, 500));
    emit({ data: { deadlineSharedProof: 'ok', rateLimit: quota } });
  } else if (query.includes('pullRequests(first:25')) {
    log({ kind: 'page', cursor, phase });
    if (phase === 'slow-page' && cursor === 'p2') await new Promise((r) => setTimeout(r, 5000));
    const nodes =
      phase === 'slow-files'
        ? page(Array.from({ length: 80 }, (_, i) => pr(i + 1)))
        : cursor === null
          ? page([pr(1), pr(2)], 'p2')
          : page([pr(3)]);
    emit({ data: { repository: { pullRequests: nodes }, rateLimit: quota } });
  } else if (query.includes('files(first:100')) {
    log({ kind: 'files', id: field('id'), phase });
    if (phase === 'slow-files') await new Promise((r) => setTimeout(r, 5000));
    emit({
      data: {
        node: {
          id: field('id'),
          headRefOid: 'a'.repeat(40),
          baseRefOid: 'b'.repeat(40),
          files: page([{ path: 'src/a.ts' }]),
        },
        rateLimit: quota,
      },
    });
  } else {
    throw new Error('Unsupported fixture GraphQL operation');
  }
} else {
  throw new Error('Unsupported fixture gh operation');
}
