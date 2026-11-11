import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileGitHubJq, runGitHubJq } from './github-jq.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

/** Every literal handed to `--jq` in gateway source, including both arms of a ternary. */
async function sourceJqExpressions(): Promise<string[]> {
  const found = new Set<string>();
  const literal = /'((?:[^'\\\n]|\\.)*)'/g;
  for (const file of await sourceFiles(SRC)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/'--jq',\s*([^\n]*(?:\n\s*'[^\n]*)?)/g)) {
      const segment = match[1].split(/,\s*\n|\]\s*[,)]/)[0];
      for (const item of segment.matchAll(literal)) {
        // A following flag name is a flag list (github-client's GH_FLAGS_WITH_VALUES), not a filter.
        if (!item[1].startsWith('-')) found.add(item[1].replace(/\\(.)/g, '$1'));
      }
    }
  }
  return [...found];
}

test('every --jq expression in gateway source compiles', async () => {
  const expressions = await sourceJqExpressions();
  assert(
    expressions.length >= 25,
    `expected the gateway's jq filters, found ${expressions.length}`,
  );
  for (const expression of expressions) {
    assert.doesNotThrow(() => compileGitHubJq(expression), expression);
  }
});

test('scalar results print as gh does: raw strings, empty null, integral numbers', () => {
  assert.equal(runGitHubJq('.login', { login: 'octo' }), 'octo\n');
  assert.equal(runGitHubJq('.[0].number', []), '\n');
  assert.equal(runGitHubJq('.[0].number', [{ number: 12 }]), '12\n');
  assert.equal(runGitHubJq('.n', { n: 1.5 }), '1.50\n');
  assert.equal(runGitHubJq('.b', { b: false }), 'false\n');
  assert.equal(runGitHubJq('.[].number', [{ number: 1 }, { number: 2 }]), '1\n2\n');
  assert.equal(
    runGitHubJq('.[-1].commit.committer.date', [{}, { commit: { committer: { date: 'd' } } }]),
    'd\n',
  );
});

test('objects print as Go json.Marshal: sorted keys and HTML-escaped strings', () => {
  assert.equal(
    runGitHubJq('{state:.state,head:.head.ref}', { state: 'open', head: { ref: 'a<b>&' } }),
    '{"head":"a\\u003cb\\u003e\\u0026","state":"open"}\n',
  );
  assert.equal(
    runGitHubJq('{status,base_commit:{sha:.base_commit.sha}}', {
      status: 'ahead',
      base_commit: { sha: 's' },
    }),
    '{"base_commit":{"sha":"s"},"status":"ahead"}\n',
  );
});

test('@json follows gojq: sorted keys, no HTML escaping, short control escapes', () => {
  assert.equal(
    runGitHubJq('.[] | {id,body} | @json', [{ id: 7, body: '<p>\b', extra: 1 }]),
    '{"body":"<p>\\b","id":7}\n',
  );
});

test('@tsv escapes separators and renders null as empty', () => {
  assert.equal(
    runGitHubJq('[.a, .b, .c, .d] | @tsv', { a: 'x\ty\nz\\', b: null, c: 3, d: true }),
    'x\\ty\\nz\\\\\t\t3\ttrue\n',
  );
});

test('the PR state projection matches gh output for a draft PR without review decision', () => {
  const expression =
    '([.state, .mergeable, .mergeStateStatus, .reviewDecision, .headRefName, (.createdAt // ""), (.updatedAt // ""), (.closedAt // ""), (.mergedAt // ""), .title] | @tsv), (.author.login // "")';
  const pr = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    headRefName: 'feat/x',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    title: 'Title',
    author: { is_bot: false, login: 'octo', id: 'U1', name: 'Octo' },
  };
  assert.equal(
    runGitHubJq(expression, pr),
    'OPEN\tMERGEABLE\tCLEAN\t\tfeat/x\t2026-01-01T00:00:00Z\t2026-01-02T00:00:00Z\t\t\tTitle\nocto\n',
  );
});

test('review threads keep unresolved comments and suffix bot authors', () => {
  const expression =
    '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == false) | .comments.nodes[] | {id: .databaseId, author: (if .author.__typename == "Bot" then "\\(.author.login)[bot]" else .author.login end), user_type: .author.__typename, body: (.body[0:300] // ""), path: .path, line: .line, created_at: .createdAt, in_reply_to_id: .replyTo.databaseId, html_url: .url}';
  const comment = (id: number, typename: string, login: string) => ({
    databaseId: id,
    author: { login, __typename: typename },
    body: 'é😀'.repeat(200),
    path: 'a.ts',
    line: 3,
    createdAt: 't',
    url: 'u',
    replyTo: null,
  });
  const out = runGitHubJq(expression, {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                isResolved: true,
                isOutdated: false,
                comments: { nodes: [comment(1, 'User', 'a')] },
              },
              {
                isResolved: false,
                isOutdated: false,
                comments: { nodes: [comment(2, 'Bot', 'cursor')] },
              },
            ],
          },
        },
      },
    },
  });
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, 2);
  assert.equal(parsed.author, 'cursor[bot]');
  assert.equal(parsed.in_reply_to_id, null);
  assert.equal(Array.from(parsed.body as string).length, 300, 'slices count code points');
});

test('optional iteration and alternatives tolerate missing data', () => {
  const expression =
    '.data.repository.pullRequest | (.latestOpinionatedReviews.nodes[]? | {t: "review", author: (.author.login // ""), state: .state, submittedAt: (.submittedAt // null)}), (.reviewRequests.nodes[]? | .requestedReviewer | select(. != null) | {t: "request", kind: (if .__typename == "Team" then "team" else "user" end), name: (.slug // .login // "")})';
  assert.equal(runGitHubJq(expression, { data: { repository: { pullRequest: {} } } }), '');
  assert.equal(
    runGitHubJq(expression, {
      data: {
        repository: {
          pullRequest: {
            latestOpinionatedReviews: { nodes: [{ author: null, state: 'APPROVED' }] },
            reviewRequests: {
              nodes: [
                { requestedReviewer: null },
                { requestedReviewer: { __typename: 'Team', slug: 'core' } },
              ],
            },
          },
        },
      },
    }),
    '{"author":"","state":"APPROVED","submittedAt":null,"t":"review"}\n{"kind":"team","name":"core","t":"request"}\n',
  );
});

test('runtime errors fail the filter instead of producing partial output', () => {
  assert.throws(() => runGitHubJq('.[] | .id', null), /cannot iterate over: null/);
  assert.throws(() => runGitHubJq('.foo', [1]), /expected an object/);
});

test('unsupported syntax is rejected at compile time', () => {
  for (const expression of ['.a | map(.b)', 'reduce .[] as $x (0; . + $x)', '.a + 1', '@csv']) {
    assert.throws(() => compileGitHubJq(expression), /jq:/, expression);
  }
});
