#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.PUBLICATION_FIXTURE_STATE;
if (!file) throw new Error('Fixture state missing; refusing provider access');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write('fixture-only-token');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  state.slotReport = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  fs.writeFileSync(file, JSON.stringify(state));
  process.exit(0);
}
if (args[0] !== 'api') throw new Error('Unbound fixture call');
const endpoint = args.find((value) => value === 'user' || value.startsWith('repos/'));
const method = args.includes('--method')
  ? args[args.indexOf('--method') + 1]
  : args.includes('-X')
    ? args[args.indexOf('-X') + 1]
    : 'GET';
let body;
if (endpoint === 'user') body = { login: 'reviewer' };
else if (endpoint.endsWith('/issues/42/comments')) {
  if (args.includes('--jq')) process.exit(0);
  body = [];
} else if (endpoint.endsWith('/pulls/42/comments') && method === 'POST') {
  const fields = Object.fromEntries(
    args
      .filter((value) => /^(body|commit_id|path|line|side)=/.test(value))
      .map((value) => {
        const split = value.indexOf('=');
        return [value.slice(0, split), value.slice(split + 1)];
      }),
  );
  (state.slotComments ??= []).push(fields);
  fs.writeFileSync(file, JSON.stringify(state));
  body = { id: state.slotComments.length };
} else if (endpoint.endsWith('/reviews?per_page=100')) body = [state.reviews];
else if (endpoint.endsWith('/files?per_page=100')) body = [state.files];
else if (endpoint.endsWith('/pulls/42/files')) body = state.files;
else if (endpoint.endsWith('/reviews') && method === 'POST') {
  if (!args.includes('--input')) {
    state.slotEvent = args.find((value) => value.startsWith('event='))?.slice(6);
    state.slotCommit = args.find((value) => value.startsWith('commit_id='))?.slice(10);
    fs.writeFileSync(file, JSON.stringify(state));
    process.stdout.write('{}');
    process.exit(0);
  }
  state.posts++;
  if (state.failure === 'rejected') {
    fs.writeFileSync(file, JSON.stringify(state));
    process.stdout.write(
      'HTTP/2.0 422 Unprocessable Entity\r\ncontent-type: application/json\r\n\r\n' +
        JSON.stringify({ message: 'Validation failed' }),
    );
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
  state.payload = payload;
  body = {
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
  if (state.failure !== 'before-write') state.reviews.push(body);
  fs.writeFileSync(file, JSON.stringify(state));
  if (state.failure) {
    process.stderr.write('Fixture transport lost response');
    process.exit(1);
  }
} else if (endpoint === 'repos/example/app/pulls/42')
  body = {
    number: 42,
    title: 'Private curation proof',
    body: '',
    state: 'open',
    head: { sha: state.head, ref: 'reviewed' },
    base: { sha: state.base, ref: 'main', repo: { full_name: 'example/app' } },
    user: { login: state.author },
    merged: false,
    draft: false,
  };
else throw new Error(`Unsupported fixture endpoint: ${endpoint} (${method})`);
if (args.includes('--include'))
  process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
