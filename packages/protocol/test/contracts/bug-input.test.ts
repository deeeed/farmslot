import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUG_SCORE_DIFFICULTIES,
  type BugInput,
  deriveScoreKey,
  extractImageUrls,
  flattenAdf,
  parseBugInput,
  scoreKeyForGithub,
  scoreKeyForJira,
  validateBugScore,
} from '../../src/contracts/bug-input.js';

// ── GitHub fixture ────────────────────────────────────────────────────────────

function githubIssueRaw(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Balance not updating after trade execution',
    body: [
      '## Acceptance Criteria',
      '- Balance refreshes within 3 seconds of trade',
      '- No stale cache shown',
      '',
      '## Steps to Reproduce',
      '1. Open the app',
      '2. Execute a trade',
      '3. Observe balance panel',
      '',
      '## Additional Context',
      'Screenshot: ![After trade](https://user-images.githubusercontent.com/12345/after-trade.png)',
      '',
      'Linked: example-org/example-mobile#29600',
      '',
      '<img src="https://user-images.githubusercontent.com/12345/screenshot-2.png">',
    ].join('\n'),
    labels: [
      { id: 1, name: 'bug' },
      { id: 2, name: 'priority-high' },
    ],
    state: 'OPEN',
    url: 'https://github.com/example-org/example-mobile/issues/29655',
    ...overrides,
  };
}

// ── Jira fixture ──────────────────────────────────────────────────────────────

function jiraAdfNode(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function jiraIssueRaw(overrides: Record<string, unknown> = {}) {
  return {
    key: 'MM-29655',
    fields: {
      summary: 'Transaction history does not load on first open',
      description: {
        version: 1,
        type: 'doc',
        content: [
          jiraAdfNode('Acceptance Criteria'),
          jiraAdfNode('- List shows within 2 seconds'),
          jiraAdfNode('Steps to Reproduce'),
          jiraAdfNode('1. Open history tab'),
          jiraAdfNode('2. Observe blank screen'),
        ],
      },
      labels: ['mobile', 'regression'],
      status: { name: 'In Progress' },
      components: [{ name: 'Transaction History' }, { name: 'Network Layer' }],
    },
    ...overrides,
  };
}

// ── extractImageUrls ──────────────────────────────────────────────────────────

test('extractImageUrls finds markdown images', () => {
  const body = '![Alt text](https://example.com/img.png) and ![](https://example.com/b.jpg)';
  const urls = extractImageUrls(body);
  assert.ok(urls.includes('https://example.com/img.png'));
  assert.ok(urls.includes('https://example.com/b.jpg'));
});

test('extractImageUrls finds HTML img tags', () => {
  const body = '<img src="https://example.com/screen.png" />';
  const urls = extractImageUrls(body);
  assert.ok(urls.includes('https://example.com/screen.png'));
});

test('extractImageUrls finds bare GitHub user-content URLs', () => {
  const body = 'See https://user-images.githubusercontent.com/123/shot.png for reference.';
  const urls = extractImageUrls(body);
  assert.ok(urls.includes('https://user-images.githubusercontent.com/123/shot.png'));
});

test('extractImageUrls filters out non-image URLs', () => {
  // Both URLs are in markdown image syntax; only img.png has a recognised extension.
  const body = '![](https://example.com/not-an-image) ![](https://example.com/img.png)';
  const urls = extractImageUrls(body);
  assert.ok(!urls.includes('https://example.com/not-an-image'));
  assert.ok(urls.includes('https://example.com/img.png'));
});

test('extractImageUrls deduplicates and sorts', () => {
  const body = '![](https://b.com/b.png)\n![](https://a.com/a.png)\n![](https://b.com/b.png)';
  const urls = extractImageUrls(body);
  assert.equal(urls[0], 'https://a.com/a.png');
  assert.equal(urls[1], 'https://b.com/b.png');
  assert.equal(urls.length, 2);
});

test('extractImageUrls returns empty array for no images', () => {
  assert.deepEqual(extractImageUrls('No images here.'), []);
});

// ── flattenAdf ────────────────────────────────────────────────────────────────

test('flattenAdf handles plain string passthrough', () => {
  assert.equal(flattenAdf('hello'), 'hello');
});

test('flattenAdf extracts text from ADF document', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
    ],
  };
  const result = flattenAdf(adf);
  assert.ok(result.includes('First paragraph'));
  assert.ok(result.includes('Second paragraph'));
});

test('flattenAdf handles arrays at top level', () => {
  const nodes = [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ];
  assert.equal(flattenAdf(nodes), 'a b');
});

test('flattenAdf returns empty string for null/undefined/number', () => {
  assert.equal(flattenAdf(null), '');
  assert.equal(flattenAdf(undefined), '');
  assert.equal(flattenAdf(42), '');
});

// ── parseBugInput — GitHub ───────────────────────────────────────────────────

test('parseBugInput github produces BugInput with correct shape', () => {
  const result = parseBugInput('github', githubIssueRaw());

  assert.equal(result.source, 'github');
  assert.equal(result.github_issue, 'example-org/example-mobile#29655');
  assert.equal(result.jira_key, '');
  assert.equal(result.title, 'Balance not updating after trade execution');
  assert.equal(result.state, 'open');
  assert.deepEqual(result.labels, ['bug', 'priority-high']);
  assert.deepEqual(result.components, []);
  assert.equal(result.affected_area, '');
});

test('parseBugInput github extracts acceptance criteria', () => {
  const result = parseBugInput('github', githubIssueRaw());
  assert.deepEqual(result.acceptance_criteria, [
    'Balance refreshes within 3 seconds of trade',
    'No stale cache shown',
  ]);
});

test('parseBugInput github extracts steps to reproduce', () => {
  const result = parseBugInput('github', githubIssueRaw());
  assert.deepEqual(result.steps_to_reproduce, [
    'Open the app',
    'Execute a trade',
    'Observe balance panel',
  ]);
});

test('parseBugInput github extracts screenshot basenames (≤50 chars)', () => {
  const result = parseBugInput('github', githubIssueRaw());
  // Markdown image basename
  assert.ok(result.screenshots.includes('after-trade.png'));
  // HTML img basename
  assert.ok(result.screenshots.includes('screenshot-2.png'));
});

test('parseBugInput github extracts image_urls (full URLs)', () => {
  const result = parseBugInput('github', githubIssueRaw());
  assert.ok(
    result.image_urls.includes('https://user-images.githubusercontent.com/12345/after-trade.png'),
  );
  assert.ok(
    result.image_urls.includes('https://user-images.githubusercontent.com/12345/screenshot-2.png'),
  );
});

test('parseBugInput github extracts linked PRs (excludes own number)', () => {
  const result = parseBugInput('github', githubIssueRaw());
  // The body contains example-org/example-mobile#29600 — a different number
  assert.ok(result.linked_prs.includes('example-org/example-mobile#29600'));
  // The issue's own number must not appear in linked_prs
  assert.ok(!result.linked_prs.includes('example-org/example-mobile#29655'));
});

test('parseBugInput github handles missing sections gracefully', () => {
  const raw = githubIssueRaw({ body: 'Just a description with no sections.' });
  const result = parseBugInput('github', raw);
  assert.deepEqual(result.acceptance_criteria, []);
  assert.deepEqual(result.steps_to_reproduce, []);
  assert.deepEqual(result.screenshots, []);
  assert.deepEqual(result.linked_prs, []);
  assert.deepEqual(result.image_urls, []);
});

test('parseBugInput github handles null body', () => {
  const raw = githubIssueRaw({ body: null });
  const result = parseBugInput('github', raw);
  assert.equal(result.description, '');
  assert.deepEqual(result.acceptance_criteria, []);
});

test('parseBugInput github throws on unparseable URL', () => {
  assert.throws(
    () => parseBugInput('github', { ...githubIssueRaw(), url: 'https://example.com/not-github' }),
    /Cannot parse GitHub issue URL/,
  );
});

// ── parseBugInput — Jira ──────────────────────────────────────────────────────

test('parseBugInput jira produces BugInput with correct shape', () => {
  const result = parseBugInput('jira', jiraIssueRaw());

  assert.equal(result.source, 'jira');
  assert.equal(result.jira_key, 'MM-29655');
  assert.equal(result.github_issue, '');
  assert.equal(result.title, 'Transaction history does not load on first open');
  assert.equal(result.state, 'in progress');
  assert.deepEqual(result.labels, ['mobile', 'regression']);
  assert.deepEqual(result.components, ['Transaction History', 'Network Layer']);
  assert.deepEqual(result.screenshots, []);
  assert.deepEqual(result.linked_prs, []);
});

test('parseBugInput jira flattens ADF description', () => {
  const result = parseBugInput('jira', jiraIssueRaw());
  assert.ok(result.description.includes('Acceptance Criteria'));
  assert.ok(result.description.includes('Steps to Reproduce'));
});

test('parseBugInput jira throws on Jira API error response', () => {
  assert.throws(
    () =>
      parseBugInput('jira', {
        errorMessages: ['Issue does not exist or you do not have permission'],
        errors: {},
      }),
    /Jira API error/,
  );
});

test('parseBugInput jira handles plain string description', () => {
  const raw = {
    ...jiraIssueRaw(),
    fields: { ...jiraIssueRaw().fields, description: 'Plain text description' },
  };
  const result = parseBugInput('jira', raw);
  assert.equal(result.description, 'Plain text description');
});

test('parseBugInput jira handles missing fields gracefully', () => {
  const result = parseBugInput('jira', { key: 'MM-1', fields: {} });
  assert.equal(result.jira_key, 'MM-1');
  assert.equal(result.title, '');
  assert.equal(result.description, '');
  assert.deepEqual(result.labels, []);
  assert.deepEqual(result.components, []);
  assert.equal(result.state, 'open');
});

// ── deriveScoreKey ────────────────────────────────────────────────────────────

test('deriveScoreKey derives gh-N from github_issue', () => {
  const bug = parseBugInput('github', githubIssueRaw());
  assert.equal(deriveScoreKey(bug), 'gh-29655');
});

test('deriveScoreKey lowercases jira_key', () => {
  const bug = parseBugInput('jira', jiraIssueRaw());
  assert.equal(deriveScoreKey(bug), 'mm-29655');
});

test('deriveScoreKey throws when both keys are empty', () => {
  const bare: BugInput = {
    source: 'github',
    github_issue: '',
    jira_key: '',
    title: '',
    description: '',
    acceptance_criteria: [],
    affected_area: '',
    steps_to_reproduce: [],
    labels: [],
    components: [],
    screenshots: [],
    state: 'open',
    linked_prs: [],
    image_urls: [],
  };
  assert.throws(() => deriveScoreKey(bare), /cannot derive score key/);
});

test('scoreKey helpers match deriveScoreKey (single source of truth)', () => {
  assert.equal(scoreKeyForGithub('29655'), 'gh-29655');
  assert.equal(scoreKeyForJira('MM-29655'), 'mm-29655');
  assert.equal(
    deriveScoreKey(parseBugInput('github', githubIssueRaw())),
    scoreKeyForGithub('29655'),
  );
  assert.equal(deriveScoreKey(parseBugInput('jira', jiraIssueRaw())), scoreKeyForJira('MM-29655'));
});

// ── validateBugScore ──────────────────────────────────────────────────────────

test('validateBugScore accepts valid score objects', () => {
  assert.doesNotThrow(() =>
    validateBugScore({
      issue_ref: 'gh-29655',
      difficulty: 'medium',
      one_shot_probability: 0.4,
      category: 'state-management',
    }),
  );
  assert.doesNotThrow(() =>
    validateBugScore({
      difficulty: 'extreme',
      one_shot_probability: 0,
      category: 'rendering',
    }),
  );
  assert.doesNotThrow(() =>
    validateBugScore({
      difficulty: 'low',
      one_shot_probability: 1,
      category: 'navigation',
      extra_field: 'ignored',
    }),
  );
});

test('validateBugScore accepts all valid difficulty values', () => {
  for (const diff of BUG_SCORE_DIFFICULTIES) {
    assert.doesNotThrow(() =>
      validateBugScore({ difficulty: diff, one_shot_probability: 0.5, category: 'x' }),
    );
  }
});

test('validateBugScore rejects missing required fields', () => {
  assert.throws(
    () => validateBugScore({ one_shot_probability: 0.5, category: 'x' }),
    /missing required fields/,
  );
  assert.throws(
    () => validateBugScore({ difficulty: 'low', category: 'x' }),
    /missing required fields/,
  );
  assert.throws(
    () => validateBugScore({ difficulty: 'low', one_shot_probability: 0.5 }),
    /missing required fields/,
  );
});

test('validateBugScore rejects invalid difficulty enum', () => {
  assert.throws(
    () => validateBugScore({ difficulty: 'critical', one_shot_probability: 0.5, category: 'x' }),
    /difficulty must be one of/,
  );
});

test('validateBugScore rejects out-of-range one_shot_probability', () => {
  assert.throws(
    () => validateBugScore({ difficulty: 'low', one_shot_probability: 1.1, category: 'x' }),
    /one_shot_probability must be a number in \[0, 1\]/,
  );
  assert.throws(
    () => validateBugScore({ difficulty: 'low', one_shot_probability: -0.1, category: 'x' }),
    /one_shot_probability must be a number in \[0, 1\]/,
  );
  assert.throws(
    () => validateBugScore({ difficulty: 'low', one_shot_probability: 'high', category: 'x' }),
    /one_shot_probability must be a number in \[0, 1\]/,
  );
});

test('validateBugScore rejects non-object inputs', () => {
  assert.throws(() => validateBugScore(null), /must be a JSON object/);
  assert.throws(() => validateBugScore([1, 2, 3]), /must be a JSON object/);
  assert.throws(() => validateBugScore('string'), /must be a JSON object/);
});

test('validateBugScore rejects NaN one_shot_probability', () => {
  assert.throws(
    () => validateBugScore({ difficulty: 'low', one_shot_probability: NaN, category: 'x' }),
    /one_shot_probability must be a number in \[0, 1\]/,
  );
});
