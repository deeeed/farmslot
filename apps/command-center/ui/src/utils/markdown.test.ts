import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMarkdownHtml } from './markdown.js';

test('chat markdown renders lists, links, code and tables, and shows raw HTML as text', () => {
  const html = chatMarkdownHtml(
    [
      'Done:',
      '- fixed the **test**',
      '- see [the PR](https://example.com/pr/1)',
      '',
      '```ts',
      'const a = `**not bold**`;',
      '```',
      '',
      '| step | result |',
      '| --- | --- |',
      '| lint | pass |',
      '',
      'Use the <details> element, not <script>alert(1)</script>.',
    ].join('\n'),
  );
  assert.match(html, /<ul>\s*<li>fixed the <strong>test<\/strong><\/li>/);
  assert.match(html, /<a href="https:\/\/example.com\/pr\/1">the PR<\/a>/);
  assert.match(html, /<pre><code class="language-ts">const a = `\*\*not bold\*\*`;/);
  assert.match(html, /<td>lint<\/td>/);
  assert.match(
    html,
    /Use the &lt;details&gt; element, not &lt;script&gt;alert\(1\)&lt;\/script&gt;\./,
  );
  assert.doesNotMatch(html, /<details>|<script>/);
});
