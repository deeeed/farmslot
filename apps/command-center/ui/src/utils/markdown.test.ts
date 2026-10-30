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
      '',
      "![screenshot](https://example.com/s.png?leak=1) and ![A & B's](https://example.com/ab.png)",
      '',
      '[![CI](https://example.com/badge.svg)](https://example.com/actions)',
      '',
      '<details>',
      '<summary>Evidence</summary>',
      '</details>',
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
  assert.doesNotMatch(html, /<details>|<script>|<img/);
  // An image is a link the reader can choose to open; nothing is fetched on render.
  assert.match(html, /<a href="https:\/\/example.com\/s.png\?leak=1">screenshot<\/a>/);
  assert.match(html, />A &amp; B&#39;s<\/a>/, 'alt text is escaped once');
  // A linked image (a badge) keeps the outer link and shows its alt text.
  assert.match(html, /<a href="https:\/\/example.com\/actions">CI<\/a>/);
  assert.doesNotMatch(html, /badge\.svg/);
  // Raw HTML on its own lines keeps them.
  assert.match(
    html,
    /<p>&lt;details&gt;<br>&lt;summary&gt;Evidence&lt;\/summary&gt;<br>&lt;\/details&gt;<\/p>/,
  );
});
