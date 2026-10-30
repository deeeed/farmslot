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
      '[**![Deploy](https://example.com/deploy.svg)**](https://example.com/deploys)',
      '[![](https://example.com/empty.svg)](https://example.com/runs)',
      '[![](https://example.com/icon.svg) Docs](https://example.com/docs)',
      '[![ ](https://example.com/blank.svg)](https://example.com/q?a=1&b="2")',
      '[![CI][badge]][ci]',
      '',
      '[badge]: https://example.com/ci.svg',
      '[ci]: https://example.com/ci',
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
  assert.doesNotMatch(html, /badge\.svg|deploy\.svg|empty\.svg|icon\.svg|blank\.svg|ci\.svg/);
  // A link with its own text gets no URL added; a blank alt is no alt; reference links work too.
  assert.match(html, /<a href="https:\/\/example.com\/docs"> Docs<\/a>/);
  assert.match(html, />https:\/\/example.com\/q\?a=1&amp;b=&quot;2&quot;<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/ci">CI<\/a>/);
  // Inside emphasis too, and with no alt text the link shows its own URL instead of nothing.
  assert.match(html, /<a href="https:\/\/example.com\/deploys"><strong>Deploy<\/strong><\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/runs">https:\/\/example.com\/runs<\/a>/);
  // Raw HTML on its own lines keeps them.
  assert.match(
    html,
    /<p>&lt;details&gt;<br>&lt;summary&gt;Evidence&lt;\/summary&gt;<br>&lt;\/details&gt;<\/p>/,
  );
});
