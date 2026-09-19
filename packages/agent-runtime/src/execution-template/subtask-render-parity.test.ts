// The `mark` engine is CJS and cannot import this package's ESM renderer, so
// scripts/subtask-unit.cjs mirrors two functions: the frontmatter strip from
// frontmatter.ts and the placeholder renderer from @farmslot/protocol. A child
// checklist must be the same bytes `task init` would write for the same source,
// so any drift here makes the provenance digests meaningless.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { renderTemplatePlaceholders } from '@farmslot/protocol';

import { parseMarkdownDocument } from './frontmatter.js';

const require = createRequire(import.meta.url);
const cjs = require('../../scripts/subtask-unit.cjs') as {
  stripMarkdownFrontmatter: (text: string) => string;
  renderPlaceholders: (text: string, vars: Record<string, string>, source: string) => string;
};

const FRONTMATTER_FIXTURES = [
  '---\nname: skill\nplatforms: [mobile]\n---\n# Body\n\n- [ ] step\n',
  '---\r\nname: skill\r\n---\r\n# CRLF body\n',
  '---\n---\n# Empty block\n',
  '# No frontmatter at all\n',
  '---\nname: unterminated\n# never closed\n',
  '---\n---not-a-fence\nname: skill\n---\n# Body after a line that only starts with dashes\n',
  '﻿---\nname: bom\n---\n# Body\n',
  'prose first\n---\nname: not frontmatter\n---\n',
];

test('stripMarkdownFrontmatter mirrors parseMarkdownDocument().body', () => {
  for (const fixture of FRONTMATTER_FIXTURES) {
    assert.equal(
      cjs.stripMarkdownFrontmatter(fixture),
      parseMarkdownDocument(fixture).body,
      `frontmatter strip drifted for ${JSON.stringify(fixture)}`,
    );
  }
});

test('renderPlaceholders mirrors renderTemplatePlaceholders', () => {
  const vars = { TASK_DIR: '/tmp/task', FLOW: 'dev', TITLE: 'A title' };
  for (const fixture of [
    '- [ ] Read {{TASK_DIR}} for the {{FLOW}} flow\n',
    '- [ ] {{TITLE}} twice: {{TITLE}}\n',
    '- [ ] no placeholders\n',
  ]) {
    assert.equal(
      cjs.renderPlaceholders(fixture, vars, 'fixture'),
      renderTemplatePlaceholders(fixture, vars, 'fixture'),
      `render drifted for ${JSON.stringify(fixture)}`,
    );
  }
});

test('renderPlaceholders refuses the same unknown tokens as the protocol guard', () => {
  const vars = { FLOW: 'dev' };
  for (const fixture of ['- [ ] {{NOPE}}\n', '- [ ] {{foo-bar}}\n', '- [ ] {{FLOW}} {{OTHER}}\n']) {
    const mirrored = (() => {
      try {
        cjs.renderPlaceholders(fixture, vars, 'fixture');
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const canonical = (() => {
      try {
        renderTemplatePlaceholders(fixture, vars, 'fixture');
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    assert.ok(canonical, `the protocol guard must reject ${JSON.stringify(fixture)}`);
    assert.equal(mirrored, canonical, `refusal drifted for ${JSON.stringify(fixture)}`);
  }
});
