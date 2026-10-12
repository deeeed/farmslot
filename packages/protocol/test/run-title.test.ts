import assert from 'node:assert/strict';
import test from 'node:test';

import { runDisplayTitle, taskTitleText } from '../src/runs/run-title.js';

const htmlReport =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EchoBridge Android native QA</title><style>body{font:16px system-ui}</style></head><body><h1>EchoBridge Android native QA</h1><p>PASS for all three admitted native cases.</p></body></html>';
const markdownReport =
  '# PR #112 native dispatch proof\n\nFull report content stays in the artifact.';

test('family report titles extract HTML title and Markdown heading', () => {
  assert.equal(taskTitleText(htmlReport), 'EchoBridge Android native QA');
  assert.equal(taskTitleText(markdownReport), 'PR #112 native dispatch proof');
  assert.equal(runDisplayTitle({ summary: htmlReport }).title, 'EchoBridge Android native QA');
  assert.equal(runDisplayTitle({ summary: markdownReport }).title, 'PR #112 native dispatch proof');
});

test('HTML uses title before h1, then h1 text when title is absent', () => {
  assert.equal(taskTitleText('<h1>Body heading</h1><title>Page title</title>'), 'Page title');
  assert.equal(
    taskTitleText('<!doctype html><h1> QA <b>report</b> &amp; results </h1>'),
    'QA report & results',
  );
});

test('plain tasks use their first line and normalized whitespace', () => {
  assert.equal(taskTitleText('  Fix   selection\nDetailed instructions\n'), 'Fix selection');
  assert.equal(taskTitleText('Intro\n## Validate published head on iOS\nDetails'), 'Intro');
});

test('bounded cards retain the full normalized title for hover', () => {
  const full = 'A long task title '.repeat(15).trim();
  const run = { summary: `# ${full}\nTask description` };
  assert.equal(runDisplayTitle(run).title.length, 120);
  assert.ok(runDisplayTitle(run).title.endsWith('…'));
  assert.equal(runDisplayTitle(run, Infinity).title, full);
});

test('later acceptance headings and code comments never replace a free-text first-line title', () => {
  assert.equal(
    taskTitleText('Make the run list sortable\n\n## Acceptance Criteria\n- Sort by date'),
    'Make the run list sortable',
  );
  assert.equal(taskTitleText('Deploy node\n```\n# build\nyarn build\n```'), 'Deploy node');
  assert.equal(taskTitleText('Fix header\n```html\n<h1>Welcome</h1>\n```'), 'Fix header');
});

test('shared display retains each client title source priority', () => {
  const run = {
    summary: 'Generated run summary',
    ticketData: { title: 'Fetched issue title' },
    ticketOrPr: 'TAT-78001',
  };
  assert.equal(runDisplayTitle(run).title, 'Fetched issue title');
  assert.equal(runDisplayTitle(run, 120, 'summary').title, 'Generated run summary');
});
