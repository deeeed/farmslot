#!/usr/bin/env node
// Review publication provider fixture, state in PUBLICATION_FIXTURE_STATE.
// On PATH as `gh` it answers keyring credential reads only. GitHub API traffic reaches
// startReviewProviderFixture()'s HTTP server through FARMSLOT_GITHUB_API_URL.
const fs = require('node:fs');
const http = require('node:http');

function stateFile() {
  const file = process.env.PUBLICATION_FIXTURE_STATE;
  if (!file) throw new Error('Fixture state missing; refusing provider access');
  return file;
}

function load() {
  return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
}

function save(state) {
  fs.writeFileSync(stateFile(), JSON.stringify(state));
}

/**
 * GitHub validates `rateLimit` as a field of Query only: a mutation that selects it is
 * rejected with HTTP 200 and a validation error, and nothing is mutated.
 */
function rejectMutationRateLimit(query) {
  if (!/^\s*mutation\b/.test(query) || !/\brateLimit\b/.test(query)) return undefined;
  return {
    errors: [
      {
        path: ['mutation', 'rateLimit'],
        extensions: { code: 'undefinedField', typeName: 'Mutation', fieldName: 'rateLimit' },
        message: "Field 'rateLimit' doesn't exist on type 'Mutation'",
      },
    ],
  };
}

/** One GitHub API request against the fixture state: { status, body } or { destroy: true }. */
function handleReviewProviderRequest({ method, pathname, payload }) {
  const state = load();
  if (pathname === '/graphql') {
    const invalid = rejectMutationRateLimit(payload.query);
    if (invalid) return { body: invalid };
    const fields = { query: payload.query, ...payload.variables };
    const pr = {
      id: 'PR_fixture42',
      headRefOid: state.head,
      baseRefOid: state.base ?? 'b'.repeat(40),
    };
    if (fields.query.includes('markFileAsViewed')) {
      if (!state.posts && !state.slotReport) throw new Error('Viewed mutation before publication');
      state.viewedMutations = (state.viewedMutations ?? 0) + 1;
      save(state);
      return {
        body: state.viewedFailure
          ? { errors: [{ message: 'Viewed unavailable' }] }
          : {
              data: Object.fromEntries(
                Object.keys(fields)
                  .filter((key) => /^path\d+$/.test(key))
                  .map((key) => [key.replace('path', 'file'), { pullRequest: pr }]),
              ),
            },
      };
    }
    if (fields.query.includes('repository(')) {
      return {
        body: {
          data: {
            viewer: { login: 'reviewer' },
            repository: {
              pullRequest: {
                ...pr,
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                changedFiles: state.files.length,
                files: {
                  nodes: state.files.map((file) => ({ path: file.filename })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      };
    }
    return { body: { data: { node: pr } } };
  }
  if (pathname === '/user') return { body: { login: 'reviewer' } };
  if (pathname === '/repos/example/app/issues/42/comments') {
    if (method !== 'POST') return { body: [] };
    state.slotReport = payload.body;
    save(state);
    return { status: 201, body: { html_url: 'https://github.com/example/app/pull/42#comment' } };
  }
  if (pathname === '/repos/example/app/pulls/42/comments' && method === 'POST') {
    // Recorded as the string fields the slot path sends.
    (state.slotComments ??= []).push(
      Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, String(value)])),
    );
    save(state);
    return { status: 201, body: { id: state.slotComments.length } };
  }
  if (pathname === '/repos/example/app/pulls/42/reviews' && method === 'GET')
    return { body: state.reviews };
  if (pathname === '/repos/example/app/pulls/42/files') return { body: state.files };
  if (pathname === '/repos/example/app/pulls/42/reviews' && method === 'POST') {
    if (!('comments' in payload)) {
      state.slotEvent = payload.event;
      state.slotCommit = payload.commit_id;
      save(state);
      return { body: {} };
    }
    state.posts++;
    if (state.failure === 'rejected') {
      save(state);
      return { status: 422, body: { message: 'Validation failed' } };
    }
    state.payload = payload;
    const review = {
      id: 123,
      commit_id: payload.commit_id,
      body: payload.body,
      user: { login: 'reviewer' },
      state: { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[
        payload.event
      ],
      submitted_at: new Date().toISOString(),
      html_url: 'https://github.com/example/app/pull/42#pullrequestreview-123',
    };
    if (state.failure !== 'before-write') state.reviews.push(review);
    save(state);
    // A lost response: the connection drops after the provider recorded (or refused) the write.
    if (state.failure) return { destroy: true };
    return { body: review };
  }
  if (pathname === '/repos/example/app/pulls/42')
    return {
      body: {
        number: 42,
        title: 'Private curation proof',
        body: '',
        state: 'open',
        head: { sha: state.head, ref: 'reviewed' },
        base: { sha: state.base, ref: 'main', repo: { full_name: 'example/app' } },
        user: { login: state.author },
        merged: false,
        draft: false,
      },
    };
  throw new Error(`Unsupported fixture endpoint: ${pathname} (${method})`);
}

/** Serve the fixture on a loopback port; resolves to { origin, close }. */
function startReviewProviderFixture() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const raw = Buffer.concat(chunks).toString('utf8');
      let response;
      try {
        response = handleReviewProviderRequest({
          method: req.method ?? 'GET',
          pathname: url.pathname,
          payload: raw ? JSON.parse(raw) : {},
        });
      } catch (error) {
        response = { status: 500, body: { message: `Fixture failure: ${error.message}` } };
      }
      if (response.destroy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(response.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(response.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = {
  handleReviewProviderRequest,
  rejectMutationRateLimit,
  startReviewProviderFixture,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] !== 'auth' || args[1] !== 'token') throw new Error('Unbound fixture call');
  const state = load();
  (state.accountLookups ??= []).push({
    named: args.includes('--user'),
    ambientPatRemoved: !process.env.GH_TOKEN,
    inheritedToken: process.env.GITHUB_TOKEN === 'fixture-inherited-token',
  });
  save(state);
  process.stdout.write('fixture-only-token');
}
