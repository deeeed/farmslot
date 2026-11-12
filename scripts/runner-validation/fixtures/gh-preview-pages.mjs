// Controlled GitHub transport for the isolated gateway recipe. Never calls gh/network.
// As `gh` it answers credential reads only; startPreviewPagesFixture() serves the API the
// gateway reaches through FARMSLOT_GITHUB_API_URL.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

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

async function answer(root, method, pathname, payload) {
  const phase = readFileSync(`${root}/phase`, 'utf8').trim();
  const log = (event) => appendFileSync(`${root}/requests.jsonl`, JSON.stringify(event) + '\n');
  if (method === 'GET' && pathname === '/user') return { login: 'fixture-user' };
  if (method !== 'POST' || pathname !== '/graphql')
    throw new Error('Unsupported fixture GitHub operation');
  const query = payload.query ?? '';
  const variables = payload.variables ?? {};
  const cursor = variables.cursor ?? null;
  const quota = { cost: 1, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() };
  if (query.includes('deadlineSharedProof')) {
    log({ kind: 'shared' });
    await new Promise((r) => setTimeout(r, 500));
    return { data: { deadlineSharedProof: 'ok', rateLimit: quota } };
  }
  if (query.includes('pullRequests(first:25')) {
    log({ kind: 'page', cursor, phase });
    if (phase === 'slow-page' && cursor === 'p2') await new Promise((r) => setTimeout(r, 5000));
    const nodes =
      phase === 'slow-files'
        ? page(Array.from({ length: 80 }, (_, i) => pr(i + 1)))
        : cursor === null
          ? page([pr(1), pr(2)], 'p2')
          : page([pr(3)]);
    return { data: { repository: { pullRequests: nodes }, rateLimit: quota } };
  }
  if (query.includes('files(first:100')) {
    log({ kind: 'files', id: variables.id, phase });
    if (phase === 'slow-files') await new Promise((r) => setTimeout(r, 5000));
    return {
      data: {
        node: {
          id: variables.id,
          headRefOid: 'a'.repeat(40),
          baseRefOid: 'b'.repeat(40),
          files: page([{ path: 'src/a.ts' }]),
        },
        rateLimit: quota,
      },
    };
  }
  throw new Error('Unsupported fixture GraphQL operation');
}

/** Serve the fixture API for one recipe directory; resolves to { origin, close }. */
export function startPreviewPagesFixture(root) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const raw = Buffer.concat(chunks).toString('utf8');
      answer(root, req.method ?? 'GET', url.pathname, raw ? JSON.parse(raw) : {}).then(
        (body) => {
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4999',
          });
          res.end(JSON.stringify(body));
        },
        (error) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: error.message }));
        },
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== 'auth' || args[1] !== 'token')
    throw new Error('Unsupported fixture gh operation');
  process.stdout.write('synthetic-github-credential');
}
