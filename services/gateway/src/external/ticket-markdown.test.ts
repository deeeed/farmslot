import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAcceptanceCriteria } from '../tasks/task-document.js';

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
      '- (done) done thing',
      '- (todo) open thing',
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

test('Markdown checklist bodies (GitHub issues) give one criterion per checkbox item', () => {
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
    '###### Expected behavior\n\n- Preview equals the charge.\n- Points match.\n\n###### Steps to reproduce\n\nOpen the order form.\n\nEnter a size.',
  );
  assert.deepEqual(data.acceptanceCriteria, ['Preview equals the charge.', 'Points match.']);
  assert.deepEqual(data.stepsToReproduce, ['Open the order form.', 'Enter a size.']);
  assert.equal(data.affectedArea, 'Perps');
  assert.deepEqual(data.comments, ['Ana (2026-10-05): First. Second.']);
});

test('fenced code never ends a section or splits an item, and its lines stay with their item', () => {
  const markdown = [
    '## Steps to reproduce',
    '1. Start the app:',
    '   ```bash',
    '   # start the app',
    '   - not a step',
    '   ```',
    '2. Open the form.',
    '```bash',
    '# a comment at column 0',
    '```',
    '3. Submit.',
    '## Notes',
    'later',
  ].join('\n');
  assert.deepEqual(sectionItems(extractSection(markdown, ['steps to reproduce'])), [
    'Start the app:\n```bash\n# start the app\n- not a step\n```',
    'Open the form.\n```bash\n# a comment at column 0\n```',
    'Submit.',
  ]);
});

test('uniformly indented list items stay siblings; deeper ones nest', () => {
  const body = '## Acceptance Criteria\n  - [ ] a\n  - [ ] b\n    - child of b\n';
  assert.deepEqual(sectionItems(extractSection(body, ['acceptance criteria'])), [
    'a',
    'b\n- child of b',
  ]);
});

test('subheadings inside the criteria prefix their items instead of becoming criteria', () => {
  const markdown = ticketBodyToMarkdown(
    doc(
      heading(4, 'Acceptance criteria'),
      heading(5, 'Mobile'),
      bullets(item(paragraph(text('m1'))), item(paragraph(text('m2')))),
      heading(5, 'Extension'),
      bullets(item(paragraph(text('e1')))),
      heading(4, 'Notes'),
      paragraph(text('later')),
    ),
  );
  assert.deepEqual(sectionItems(extractSection(markdown, ['acceptance criteria'])), [
    'Mobile: m1',
    'Mobile: m2',
    'Extension: e1',
  ]);
});

test('headings with emoji, a trailing parenthetical or a colon still match', () => {
  assert.equal(
    extractSection('### :white_check_mark: Acceptance Criteria (AC):\n- one', [
      'acceptance criteria',
    ]),
    '- one',
  );
  assert.equal(
    extractSection('## ✅ Acceptance criteria\n- one', ['acceptance criteria']),
    '- one',
  );
});

test('captions, layouts, decision lists and nested task lists keep their words apart', () => {
  const markdown = ticketBodyToMarkdown(
    doc(
      {
        type: 'mediaSingle',
        content: [
          { type: 'media', attrs: { id: 'x' } },
          { type: 'caption', content: [text('Fee preview screenshot')] },
        ],
      },
      {
        type: 'layoutSection',
        content: [
          {
            type: 'layoutColumn',
            content: [
              heading(2, 'Acceptance criteria'),
              bullets(item(paragraph(text('A1'))), item(paragraph(text('A2')))),
            ],
          },
          { type: 'layoutColumn', content: [paragraph(text('Right column'))] },
        ],
      },
      {
        type: 'decisionList',
        content: [
          { type: 'decisionItem', content: [text('Decision one')] },
          { type: 'decisionItem', content: [text('Decision two')] },
        ],
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('parent')] },
          {
            type: 'taskList',
            content: [
              { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('child1')] },
              { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('child2')] },
            ],
          },
        ],
      },
    ),
  );
  assert.equal(
    markdown,
    [
      'Fee preview screenshot',
      '',
      '## Acceptance criteria',
      '',
      '- A1',
      '- A2',
      '',
      'Right column',
      '',
      '- Decision one',
      '- Decision two',
      '',
      '- (todo) parent',
      '  - (done) child1',
      '  - (todo) child2',
    ].join('\n'),
  );
  assert.deepEqual(sectionItems(extractSection(markdown, ['acceptance criteria'])), [
    'A1',
    'A2',
    'Right column',
    'Decision one',
    'Decision two',
    'parent\n- (done) child1\n- (todo) child2',
  ]);
});

test('fetchJiraIssue finds deep criteria on the ticket heading levels, not the shifted ones', async (t) => {
  const savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    delete process.env.JIRA_DEEP_EMAIL;
    delete process.env.JIRA_DEEP_TOKEN;
  });
  process.env.JIRA_DEEP_EMAIL = 'bot@example.test';
  process.env.JIRA_DEEP_TOKEN = 'token';
  globalThis.fetch = async (input) => {
    const body = String(input).includes('/comment')
      ? { comments: [] }
      : {
          key: 'ABC-2',
          fields: {
            summary: 's',
            description: doc(
              heading(4, 'Acceptance criteria'),
              heading(5, 'Mobile'),
              bullets(item(paragraph(text('m1')))),
              heading(5, 'Extension'),
              bullets(item(paragraph(text('e1')))),
            ),
            status: { name: 'To Do' },
            issuetype: { name: 'Task' },
            labels: [],
            components: [],
          },
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const data = await fetchJiraIssue('ABC-2', {
    baseUrl: 'https://jira.example.test',
    emailEnv: 'JIRA_DEEP_EMAIL',
    apiTokenEnv: 'JIRA_DEEP_TOKEN',
  });
  assert.deepEqual(data.acceptanceCriteria, ['Mobile: m1', 'Extension: e1']);
  assert.match(data.description ?? '', /^###### Acceptance criteria$/m);
});

test('bold criteria and bold continuation paragraphs stay criteria, through to TASK.md', async (t) => {
  const savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    delete process.env.JIRA_BOLD_EMAIL;
    delete process.env.JIRA_BOLD_TOKEN;
  });
  process.env.JIRA_BOLD_EMAIL = 'bot@example.test';
  process.env.JIRA_BOLD_TOKEN = 'token';
  const bold = (value: string) => text(value, [{ type: 'strong' }]);
  globalThis.fetch = async (input) => {
    const body = String(input).includes('/comment')
      ? { comments: [] }
      : {
          key: 'ABC-3',
          fields: {
            summary: 's',
            description: doc(
              heading(2, 'Acceptance criteria'),
              paragraph(bold('Preview equals the charge.')),
              paragraph(bold('Points match.')),
              heading(2, 'Steps to reproduce'),
              ordered(
                item(
                  paragraph(text('Open the form.')),
                  paragraph(bold('Use a discounted account.')),
                ),
              ),
            ),
            status: { name: 'To Do' },
            issuetype: { name: 'Bug' },
            labels: [],
            components: [],
          },
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const data = await fetchJiraIssue('ABC-3', {
    baseUrl: 'https://jira.example.test',
    emailEnv: 'JIRA_BOLD_EMAIL',
    apiTokenEnv: 'JIRA_BOLD_TOKEN',
  });
  assert.deepEqual(data.acceptanceCriteria, [
    '**Preview equals the charge.**',
    '**Points match.**',
  ]);
  assert.equal(
    renderAcceptanceCriteria(data.acceptanceCriteria ?? []),
    '- **Preview equals the charge.**\n- **Points match.**',
  );
  assert.deepEqual(data.stepsToReproduce, ['Open the form.\n**Use a discounted account.**']);
});

test('a line that only starts with inline backticks is not a fence', () => {
  const body = [
    '## Steps to reproduce',
    '```yarn start``` then open the page',
    '## Acceptance Criteria',
    '- [ ] a',
    '- [ ] b',
  ].join('\n');
  assert.deepEqual(sectionItems(extractSection(body, ['acceptance criteria'])), ['a', 'b']);
  assert.equal(extractSection(body, ['steps to reproduce']), '```yarn start``` then open the page');
});

test('a list item ending in a colon is not a section label', () => {
  const body = [
    '## Steps to reproduce',
    '1. Open the form.',
    '   - Expected result:',
    '     - error shown',
    '2. Submit.',
  ].join('\n');
  assert.equal(extractSection(body, ['expected result']), '');
});

test('a bold label right before a list groups it; a bold line on its own stays a criterion', () => {
  const grouped = [
    '## Acceptance Criteria',
    '**Mobile**',
    '- m1',
    '- m2',
    '**Extension**',
    '- e1',
  ].join('\n');
  assert.deepEqual(sectionItems(extractSection(grouped, ['acceptance criteria'])), [
    'Mobile: m1',
    'Mobile: m2',
    'Extension: e1',
  ]);
  // A bold paragraph continuing an item stays with that item, even with siblings after it.
  const bold = (value: string) => text(value, [{ type: 'strong' }]);
  for (const list of [bullets, ordered]) {
    const markdown = ticketBodyToMarkdown(
      doc(
        heading(2, 'Acceptance criteria'),
        list(
          item(paragraph(text('First criterion')), paragraph(bold('Important'))),
          item(paragraph(text('Second criterion'))),
          item(paragraph(text('Third'))),
        ),
      ),
    );
    assert.deepEqual(sectionItems(extractSection(markdown, ['acceptance criteria'])), [
      'First criterion\n**Important**',
      'Second criterion',
      'Third',
    ]);
  }
  const plain = '## Acceptance Criteria\n\n**Preview equals the charge.**\n\n**Points match.**';
  assert.deepEqual(sectionItems(extractSection(plain, ['acceptance criteria'])), [
    '**Preview equals the charge.**',
    '**Points match.**',
  ]);
});
