import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { publishWorkspaceReview, type ReviewPublicationReceipt } from './provider.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'review-publication-provider-'));
await mkdir(path.join(root, 'bin'));
await writeFile(
  path.join(root, 'bin/gh'),
  String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.PUBLICATION_FIXTURE_STATE;
if (!file) throw new Error('Fixture state missing; refusing provider access');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'token') { process.stdout.write('fixture-only-token'); process.exit(0); }
if (args[0] !== 'api' || process.env.GH_TOKEN !== 'fixture-only-token') throw new Error('Unbound fixture call');
const endpoint = args.find(value => value === 'user' || value.startsWith('repos/'));
const method = args[args.indexOf('--method') + 1];
let body;
if (endpoint === 'user') body = { login: 'reviewer' };
else if (endpoint.endsWith('/reviews?per_page=100')) body = [state.reviews];
else if (endpoint.endsWith('/reviews') && method === 'POST') {
  state.posts++;
  if (state.failure === 'rejected') {
    fs.writeFileSync(file, JSON.stringify(state));
    process.stdout.write('HTTP/2.0 422 Unprocessable Entity\r\ncontent-type: application/json\r\n\r\n' + JSON.stringify({message:'Validation failed'}));
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
  state.payload = payload;
  body = { id: 123, commit_id: payload.commit_id, body: payload.body, user: { login: 'reviewer' }, state: { APPROVE:'APPROVED',REQUEST_CHANGES:'CHANGES_REQUESTED',COMMENT:'COMMENTED' }[payload.event], submitted_at: new Date().toISOString(), html_url:'https://github.com/example/app/pull/42#pullrequestreview-123' };
  if (state.failure !== 'before-write') state.reviews.push(body);
  fs.writeFileSync(file, JSON.stringify(state));
  if (state.failure) { process.stderr.write('Fixture transport lost response'); process.exit(1); }
} else if (endpoint === 'repos/example/app/pulls/42') body = { number:42, state:'open', head:{sha:state.head}, base:{repo:{full_name:'example/app'}}, user:{login:state.author} };
else throw new Error('Unsupported fixture endpoint');
if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
`,
  { mode: 0o700 },
);
const priorPath = process.env.PATH;
process.env.PATH = path.join(root, 'bin') + path.delimiter + priorPath;
after(async () => {
  process.env.PATH = priorPath;
  delete process.env.PUBLICATION_FIXTURE_STATE;
  await rm(root, { recursive: true, force: true });
});
const head = 'a'.repeat(40);
async function fixture(overrides: Record<string, unknown> = {}) {
  const directory = path.join(root, randomUUID());
  await mkdir(directory);
  const stateFile = path.join(directory, 'provider.json');
  const state = { reviews: [], posts: 0, head, author: 'author', ...overrides };
  await writeFile(stateFile, JSON.stringify(state));
  process.env.PUBLICATION_FIXTURE_STATE = stateFile;
  const receiptFile = path.join(directory, 'receipt.json');
  let receipt: ReviewPublicationReceipt | undefined;
  const run = {
    id: randomUUID(),
    flowType: 'review-pr',
    status: 'done',
    ticketOrPr: 'example/app#42',
    createdByPrincipalId: 'owner',
    reviewWorkspaceSubject: { repository: 'example/app', headSha: head },
    reviewResult: {
      recommendation: 'APPROVE',
      reviewMd: 'Checked source. No blocking findings.',
      reviewSnapshot: { source: 'github-pr', headSha: head },
      lineComments: [
        {
          path: 'src/example.ts',
          line: 3,
          body: 'Keep this invariant documented.',
          severity: 'suggestion',
        },
      ],
    },
  } as unknown as Run;
  const input = {
    run,
    ownerId: 'owner',
    account: { host: 'github.com', login: 'reviewer' },
    pr: { host: 'github.com', repo: 'example/app', number: 42 },
    authorize: async () => {},
    readReceipt: async () => receipt,
    saveReceipt: async (value: ReviewPublicationReceipt) => {
      await writeFile(receiptFile, JSON.stringify(value));
      receipt = structuredClone(value);
    },
  };
  return {
    input,
    state: async () => JSON.parse(await readFile(stateFile, 'utf8')),
    setState: async (value: unknown) => writeFile(stateFile, JSON.stringify(value)),
    reload: async () => {
      receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    },
    receipt: () => receipt,
  };
}

test('one pinned review contains body and inline findings; receipt retries do not repost', async () => {
  const f = await fixture();
  const receipt = await publishWorkspaceReview(f.input);
  assert.equal(receipt.state, 'published');
  assert.equal(receipt.headSha, head);
  const state = await f.state();
  assert.equal(state.posts, 1);
  assert.equal(state.payload.commit_id, head);
  assert.equal(state.payload.comments.length, 1);
  assert.equal(state.payload.comments[0].side, 'RIGHT');
  await f.reload();
  assert.deepEqual(await publishWorkspaceReview(f.input), receipt);
  assert.equal((await f.state()).posts, 1);
});

test('lost response recovers an owned exact-content provider review from the durable attempt', async () => {
  const f = await fixture({ failure: 'after-write' });
  await assert.rejects(publishWorkspaceReview(f.input));
  assert.equal(f.receipt()?.state, 'posting');
  await f.reload();
  assert.equal((await publishWorkspaceReview(f.input)).state, 'published');
  assert.equal((await f.state()).posts, 1);
});

test('uncertain absence never causes a duplicate mutation on retry', async () => {
  const f = await fixture({ failure: 'before-write' });
  await assert.rejects(publishWorkspaceReview(f.input));
  await f.reload();
  await assert.rejects(publishWorkspaceReview(f.input), /uncertain/);
  assert.equal((await f.state()).posts, 1);
});

test('stale heads and changed authorization create no provider mutation', async () => {
  const stale = await fixture({ head: 'b'.repeat(40) });
  await assert.rejects(publishWorkspaceReview(stale.input), /changed since/);
  assert.equal((await stale.state()).posts, 0);
  const revoked = await fixture();
  let checks = 0;
  revoked.input.authorize = async () => {
    if (++checks === 2) throw new Error('Authority revoked');
  };
  await assert.rejects(publishWorkspaceReview(revoked.input), /revoked/);
  assert.equal((await revoked.state()).posts, 0);
  assert.equal(revoked.receipt(), undefined);
});

test('foreign ownership, another PR and QA are rejected before publication', async () => {
  const f = await fixture();
  await assert.rejects(publishWorkspaceReview({ ...f.input, ownerId: 'other' }), /owner/);
  await assert.rejects(
    publishWorkspaceReview({ ...f.input, pr: { ...f.input.pr, number: 43 } }),
    /original review request/,
  );
  await assert.rejects(
    publishWorkspaceReview({ ...f.input, run: { ...f.input.run, flowType: 'qa' } }),
    /static review/,
  );
  assert.equal((await f.state()).posts, 0);
});

test('self-authored PR uses a comment event instead of prohibited self-approval', async () => {
  const f = await fixture({ author: 'reviewer' });
  assert.equal((await publishWorkspaceReview(f.input)).event, 'COMMENT');
  assert.equal((await f.state()).posts, 1);
});

test('edited provider body cannot satisfy recovery even when its marker survives', async () => {
  const f = await fixture({ failure: 'after-write' });
  await assert.rejects(publishWorkspaceReview(f.input));
  const state = await f.state();
  state.reviews[0].body = 'Edited\n' + state.reviews[0].body;
  await f.setState(state);
  await assert.rejects(publishWorkspaceReview(f.input), /does not confirm/);
  assert.equal((await f.state()).posts, 1);
});

test('revocation after receipt persistence remains retryable because no post was attempted', async () => {
  const f = await fixture();
  let checks = 0;
  f.input.authorize = async () => {
    if (++checks === 3) throw new Error('Authority revoked after reservation');
  };
  await assert.rejects(publishWorkspaceReview(f.input), /after reservation/);
  assert.equal(f.receipt()?.state, 'prepared');
  assert.equal((await f.state()).posts, 0);
  await f.reload();
  f.input.authorize = async () => {};
  assert.equal((await publishWorkspaceReview(f.input)).state, 'published');
  assert.equal((await f.state()).posts, 1);
});

test('a definite provider rejection remains retryable without treating transport failure as rejection', async () => {
  const f = await fixture({ failure: 'rejected' });
  await assert.rejects(publishWorkspaceReview(f.input), /HTTP 422/);
  assert.equal(f.receipt()?.state, 'prepared');
  assert.equal((await f.state()).reviews.length, 0);
  await f.reload();
  await f.setState({ ...(await f.state()), failure: undefined });
  assert.equal((await publishWorkspaceReview(f.input)).state, 'published');
  assert.equal((await f.state()).reviews.length, 1);
  assert.equal((await f.state()).posts, 2);
});
