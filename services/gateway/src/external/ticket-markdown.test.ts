import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchJiraIssue } from './jira.js';
import {
  adfToInlineText,
  extractSection,
  sectionItems,
  ticketBodyToMarkdown,
  wikiToMarkdown,
} from './ticket-markdown.js';

// Synthetic ADF shaped like real Jira REST v3 descriptions (headings, ordered and
// bullet lists, code and link marks, tables). No real ticket content.
const text = (value: string, marks?: Array<Record<string, unknown>>) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const heading = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const item = (...content: unknown[]) => ({ type: 'listItem', content });
const ordered = (...items: unknown[]) => ({
  type: 'orderedList',
  attrs: { order: 1 },
  content: items,
});
const bullets = (...items: unknown[]) => ({ type: 'bulletList', content: items });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

const bugTicket = doc(
  heading(2, 'Problem'),
  paragraph(text('The preview applies the discount twice.')),
  paragraph(text('Reported on the order form.')),
  heading(2, 'Cause'),
  bullets(
    item(
      paragraph(
        text('Core '),
        text('#123', [{ type: 'link', attrs: { href: 'https://example.test/pr/123' } }]),
        text(' changed '),
        text('feeRate()', [{ type: 'code' }]),
        text('.'),
      ),
    ),
  ),
  heading(2, 'Acceptance criteria'),
  ordered(
    item(
      paragraph(
        text('Preview equals the charged fee ('),
        text('rate × (1 − d)', [{ type: 'code' }]),
        text(').'),
      ),
    ),
    item(paragraph(text('A waiver keeps the preview equal to the charge.'))),
    item(
      paragraph(text('Points use the same fee.')),
      bullets(item(paragraph(text('including the estimate tooltip')))),
    ),
  ),
);

test('ADF keeps paragraphs, lists, marks and headings, nested under the host document', () => {
  const markdown = ticketBodyToMarkdown(bugTicket, { headingOffset: 2 });
  assert.equal(
    markdown,
    [
      '#### Problem',
      '',
      'The preview applies the discount twice.',
      '',
      'Reported on the order form.',
      '',
      '#### Cause',
      '',
      '- Core [#123](https://example.test/pr/123) changed `feeRate()`.',
      '',
      '#### Acceptance criteria',
      '',
      '1. Preview equals the charged fee (`rate × (1 − d)`).',
      '2. A waiver keeps the preview equal to the charge.',
      '3. Points use the same fee.',
      '   - including the estimate tooltip',
    ].join('\n'),
  );
});

test('the acceptance criteria are found by heading and split into one item per top-level entry', () => {
  const markdown = ticketBodyToMarkdown(bugTicket, { headingOffset: 2 });
  assert.deepEqual(sectionItems(extractSection(markdown, ['acceptance criteria'])), [
    'Preview equals the charged fee (`rate × (1 − d)`).',
    'A waiver keeps the preview equal to the charge.',
    'Points use the same fee.\n- including the estimate tooltip',
  ]);
});

test('a section ends at the next heading of the same or a higher level, keeping its subheadings', () => {
  const markdown = [
    '### Expected behavior',
    'First paragraph.',
    '#### Detail',
    'Nested detail.',
    '### Steps to reproduce',
    'Open the form.',
  ].join('\n');
  assert.equal(
    extractSection(markdown, ['expected behavior']),
    'First paragraph.\n#### Detail\nNested detail.',
  );
  assert.deepEqual(sectionItems(extractSection(markdown, ['steps to reproduce'])), [
    'Open the form.',
  ]);
});

test('headings match regardless of case, trailing colon, bold-only lines and plain labels', () => {
  assert.equal(extractSection('## ACCEPTANCE CRITERIA:\n- one', ['acceptance criteria']), '- one');
  assert.equal(
    extractSection('**Acceptance Criteria**\n1. one\n**Notes**\nx', ['acceptance criteria']),
    '1. one',
  );
  assert.equal(
    extractSection('Intro.\nAcceptance criteria:\n- one\n- two\nNotes:\nlater', [
      'acceptance criteria',
    ]),
    '- one\n- two',
  );
  assert.equal(extractSection('## Overview\nNo criteria here.', ['acceptance criteria']), '');
});

test('tables, code blocks, task lists and leading-space paragraphs render as Markdown', () => {
  const markdown = ticketBodyToMarkdown(
    doc(
      paragraph(text('    indented source text')),
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [paragraph(text('error'))] },
              { type: 'tableHeader', content: [paragraph(text('count'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [paragraph(text('a|b', [{ type: 'code' }]))] },
              { type: 'tableCell', content: [paragraph(text('12', [{ type: 'strong' }]))] },
            ],
          },
        ],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [text('const a = 1;\nconst b = 2;')],
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done thing')] },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('open thing')] },
        ],
      },
    ),
  );
  assert.equal(
    markdown,
    [
      'indented source text',
      '',
      '| error | count |',
      '| --- | --- |',
      '| `a\\|b` | **12** |',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '- [x] done thing',
      '- [ ] open thing',
    ].join('\n'),
  );
});

test('wiki markup becomes Markdown with the same sections', () => {
  const wiki = [
    'h2. Problem',
    'The fee uses {{applyFeeDiscount}} twice, see [the PR|https://example.test/pr/1].',
    '',
    'h2. Acceptance criteria',
    '# Preview equals the charge.',
    '# Waiver keeps it equal.',
    '## Including the tooltip.',
    '# Points match.',
    '',
    'h2. Notes',
    '{code:ts}',
    'const x = 1;',
    '{code}',
  ].join('\n');
  const markdown = wikiToMarkdown(wiki, { headingOffset: 2 });
  assert.equal(
    markdown,
    [
      '#### Problem',
      'The fee uses `applyFeeDiscount` twice, see [the PR](https://example.test/pr/1).',
      '',
      '#### Acceptance criteria',
      '1. Preview equals the charge.',
      '2. Waiver keeps it equal.',
      '   1. Including the tooltip.',
      '3. Points match.',
      '',
      '#### Notes',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(sectionItems(extractSection(markdown, ['acceptance criteria'])), [
    'Preview equals the charge.',
    'Waiver keeps it equal.\n1. Including the tooltip.',
    'Points match.',
  ]);
  assert.equal(ticketBodyToMarkdown(wiki), wikiToMarkdown(wiki));
});

test('GitHub-style Markdown bodies keep their one-entry-per-item criteria', () => {
  const body = '## Acceptance Criteria\n- [ ] First\n- [x] Second\n\n## Notes\nlater';
  assert.deepEqual(sectionItems(extractSection(body, ['acceptance criteria'])), [
    'First',
    'Second',
  ]);
});

test('comments become one readable line: block boundaries are spaces, not glued words', () => {
  assert.equal(
    adfToInlineText(
      doc(
        paragraph(text('Looks good.')),
        bullets(item(paragraph(text('one'))), item(paragraph(text('two')))),
      ),
    ),
    'Looks good. - one - two',
  );
});

test('fetchJiraIssue turns an ADF description into Markdown with its acceptance criteria and steps', async (t) => {
  const savedFetch = globalThis.fetch;
  const savedEnv = { email: process.env.JIRA_TEST_EMAIL, token: process.env.JIRA_TEST_TOKEN };
  t.after(() => {
    globalThis.fetch = savedFetch;
    process.env.JIRA_TEST_EMAIL = savedEnv.email;
    process.env.JIRA_TEST_TOKEN = savedEnv.token;
    if (savedEnv.email === undefined) delete process.env.JIRA_TEST_EMAIL;
    if (savedEnv.token === undefined) delete process.env.JIRA_TEST_TOKEN;
  });
  process.env.JIRA_TEST_EMAIL = 'bot@example.test';
  process.env.JIRA_TEST_TOKEN = 'token';
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const body = url.includes('/comment')
      ? {
          comments: [
            {
              author: { displayName: 'Ana' },
              created: '2026-10-05T01:02:03Z',
              body: doc(paragraph(text('First.')), paragraph(text('Second.'))),
            },
          ],
        }
      : {
          key: 'ABC-1',
          fields: {
            summary: 'Fee preview doubles the discount',
            description: doc(
              heading(3, 'Expected behavior'),
              bullets(
                item(paragraph(text('Preview equals the charge.'))),
                item(paragraph(text('Points match.'))),
              ),
              heading(3, 'Steps to reproduce'),
              paragraph(text('Open the order form.')),
              paragraph(text('Enter a size.')),
            ),
            status: { name: 'To Do' },
            issuetype: { name: 'Bug' },
            labels: [],
            components: [{ name: 'Perps' }],
          },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const data = await fetchJiraIssue('ABC-1', {
    baseUrl: 'https://jira.example.test',
    emailEnv: 'JIRA_TEST_EMAIL',
    apiTokenEnv: 'JIRA_TEST_TOKEN',
  });
  assert.equal(requested.length, 2);
  assert.equal(
    data.description,
    '##### Expected behavior\n\n- Preview equals the charge.\n- Points match.\n\n##### Steps to reproduce\n\nOpen the order form.\n\nEnter a size.',
  );
  assert.deepEqual(data.acceptanceCriteria, ['Preview equals the charge.', 'Points match.']);
  assert.deepEqual(data.stepsToReproduce, ['Open the order form.', 'Enter a size.']);
  assert.equal(data.affectedArea, 'Perps');
  assert.deepEqual(data.comments, ['Ana (2026-10-05): First. Second.']);
});
