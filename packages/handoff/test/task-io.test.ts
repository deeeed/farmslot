import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractTaskDocument } from '../src/task-io/extract.js';
import { renderTaskMarkdown } from '../src/task-io/render.js';

test('text/file extraction normalizes the generic fields zero-config', () => {
  const document = extractTaskDocument({
    sourceKind: 'text',
    raw: {
      title: 'Fix the gate',
      description: 'It flakes on CI.',
      acceptanceCriteria: 'Green 50/50.',
      labels: ['bug'],
      ticket: 'PROJ-9',
    },
  });
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.sourceKind, 'text');
  assert.equal(document.title, 'Fix the gate');
  assert.equal(document.acceptanceCriteria, 'Green 50/50.');
  assert.deepEqual(document.labels, ['bug']);
  assert.equal(document.ticket, 'PROJ-9');
});

test('PII floor: person fields never survive extraction (allowlist by construction)', () => {
  const document = extractTaskDocument({
    sourceKind: 'github-issue',
    raw: {
      title: 'Crash on open',
      body: 'Repro steps included.',
      state: 'open',
      labels: [{ name: 'bug' }, { name: 'p1' }],
      user: { login: 'jane-doe', email: 'jane@example.com' },
      assignee: { login: 'john-doe' },
      assignees: [{ login: 'john-doe' }],
      comments_list: [{ author: 'someone', body: 'me too' }],
    },
    sourceRef: 'https://github.com/org/repo/issues/7',
  });
  assert.equal(document.title, 'Crash on open');
  assert.equal(document.description, 'Repro steps included.');
  assert.equal(document.status, 'open');
  assert.deepEqual(document.labels, ['bug', 'p1']);
  assert.equal(document.sourceRef, 'https://github.com/org/repo/issues/7');
  const serialized = JSON.stringify(document);
  for (const leaked of ['jane-doe', 'jane@example.com', 'john-doe', 'me too']) {
    assert.equal(serialized.includes(leaked), false, `leaked: ${leaked}`);
  }
});

test('jira ships no default map: extraction demands an opt-in fieldMap, then normalizes', () => {
  const raw = {
    key: 'PROJ-77',
    fields: {
      summary: 'Do the thing',
      description: { content: [{ content: [{ text: 'Rich text body.' }] }] },
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      reporter: { displayName: 'Jane Doe' },
    },
  };
  assert.throws(() => extractTaskDocument({ sourceKind: 'jira', raw }), /opt-in/);

  const document = extractTaskDocument(
    { sourceKind: 'jira', raw },
    {
      fieldMap: {
        title: 'fields.summary',
        description: 'fields.description',
        ticket: 'key',
        status: 'fields.status.name',
        priority: 'fields.priority.name',
      },
    },
  );
  assert.equal(document.title, 'Do the thing');
  assert.equal(document.description, 'Rich text body.');
  assert.equal(document.ticket, 'PROJ-77');
  assert.equal(document.status, 'In Progress');
  assert.equal(document.priority, 'High');
  assert.equal(JSON.stringify(document).includes('Jane Doe'), false);
});

test('extensionFields opt raw paths back in via extensions{}', () => {
  const document = extractTaskDocument(
    { sourceKind: 'text', raw: { title: 't', points: 5 } },
    { extensionFields: { storyPoints: 'points' } },
  );
  assert.deepEqual(document.extensions, { storyPoints: 5 });
});

test('renderTaskMarkdown renders the shipped default template with AC stub when absent', () => {
  const result = renderTaskMarkdown({
    task: { schemaVersion: 1, sourceKind: 'text', title: 'Fix the gate', description: 'Flaky.' },
    flowType: 'dev',
  });
  assert.equal(result.templateProvenance.tier, 'default');
  assert.ok(result.markdown.startsWith('# Fix the gate'));
  assert.ok(result.markdown.includes('Flaky.'));
  assert.ok(result.markdown.includes('No acceptance criteria provided'));
  // Provenance stays in the return value, never embedded in the markdown.
  assert.equal(result.markdown.includes(result.resolvedTemplate), false);
});

test('a personal template override wins and the default is recorded as shadowed', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'handoff-home-'));
  const templateDir = path.join(home, 'handoff/templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(path.join(templateDir, 'dev.md'), '# MINE: {{title}} [{{ticket}}]\n');

  const result = renderTaskMarkdown(
    {
      task: { schemaVersion: 1, sourceKind: 'text', title: 'Fix the gate', ticket: 'PROJ-9' },
      flowType: 'dev',
    },
    { farmslotHome: home },
  );
  assert.equal(result.templateProvenance.tier, 'personal');
  assert.equal(result.markdown, '# MINE: Fix the gate [PROJ-9]\n');
  assert.ok(result.templateProvenance.shadows.some((s) => s.tier === 'default'));
});

test('a broken personal template warns and degrades to the shipped default', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'handoff-home-'));
  const templateDir = path.join(home, 'handoff/templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(path.join(templateDir, 'dev.md'), '   \n'); // empty = broken

  const warnings: string[] = [];
  const result = renderTaskMarkdown(
    {
      task: { schemaVersion: 1, sourceKind: 'text', title: 'Fix the gate' },
      flowType: 'dev',
    },
    { farmslotHome: home, warn: (m) => warnings.push(m) },
  );
  assert.equal(result.templateProvenance.tier, 'default');
  assert.ok(result.markdown.startsWith('# Fix the gate'));
  assert.equal(warnings.length, 1);
  assert.ok(result.templateProvenance.shadows.some((s) => s.tier === 'personal'));
});

test('an explicitly configured templateRef that does not exist warns before falling back', () => {
  const warnings: string[] = [];
  const result = renderTaskMarkdown(
    {
      task: { schemaVersion: 1, sourceKind: 'text', title: 'Fix the gate' },
      flowType: 'dev',
      templateRef: '/nonexistent/custom-template.md',
    },
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(result.templateProvenance.tier, 'default');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /templateRef/);
  assert.match(warnings[0], /Next:/);
});
