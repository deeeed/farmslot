import assert from 'node:assert/strict';
import test from 'node:test';

import DOMPurify from 'dompurify';

import { preloadCodeLanguage } from './code-highlight.js';
import { chatMarkdownHtml, renderChatMarkdown } from './markdown.js';

const NEW_TAB = ' target="_blank" rel="noopener noreferrer"';

test('chat markdown renders lists, links, code and tables, and shows raw HTML as text', () => {
  const rendered = chatMarkdownHtml(
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
  // Every link opens beside Command Center; the rest of this test reads them without that.
  assert.equal(rendered.split('<a ').length, rendered.split(`<a${NEW_TAB} `).length);
  const html = rendered.replaceAll(NEW_TAB, '');
  assert.match(html, /<ul>\s*<li>fixed the <strong>test<\/strong><\/li>/);
  assert.match(html, /<a href="https:\/\/example.com\/pr\/1">the PR<\/a>/);
  // A fenced block sits in T3 Code's frame: its language, then wrap and copy controls.
  assert.match(
    html,
    /<div class="cm-code" data-wrap="true"><div class="cm-code-head"><span class="cm-code-lang">ts<\/span>.*data-code-action="wrap".*data-code-action="copy"/,
  );
  assert.match(html, /<pre><code>const a = `\*\*not bold\*\*`;/);
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

// DOMPurify needs a DOM and leaves `sanitize` undefined in node. Stand in with the identity, so
// block output is compared byte for byte with the full parse; the browser probe checks the
// sanitized output the same way.
assert.equal(DOMPurify.isSupported, false);
Reflect.set(DOMPurify, 'sanitize', (html: string) => html);
const corpus = [
  'One paragraph.\nWith a soft break.\n\nAnother paragraph.',
  '# Heading\n\nSetext heading\n===\n\n### Third\ntext right after',
  '- tight\n- list\n  - nested\n\n1. loose\n\n2. ordered\n\n   continued',
  '```ts\nconst a = 1;\n\nconst b = `x`;\n```\n\n    indented code\n\nafter',
  '| a | b |\n| --- | :-: |\n| 1 | **2** |\n\n> quoted\n> > nested\n\n---\n\nend',
  'See [the docs][docs] and [inline](https://example.com/a?b=1&c=2).\n\n[docs]: https://example.com/docs "Docs"',
  '[![CI](https://example.com/ci.svg)](https://example.com/ci) and ![alt](https://example.com/i.png)',
  'Use <details> here.\n\n<div>\n<script>alert(1)</script>\n</div>\n\ntext <b>bold</b>',
  'Unterminated fence:\n\n```\ncode that never closes',
];

test('chat markdown rendered by block matches a full parse, at every point of a stream', () => {
  for (const md of corpus) assert.equal(renderChatMarkdown(md), chatMarkdownHtml(md), md);
  // Every prefix of the whole corpus: each block is split mid-way across two deltas somewhere.
  const stream = corpus.join('\n\n');
  for (let end = 1; end <= stream.length; end += 7) {
    const md = stream.slice(0, end);
    assert.equal(renderChatMarkdown(md), chatMarkdownHtml(md), JSON.stringify(md));
  }
});

test('a reference definition arriving after its link re-renders the link', () => {
  const before = 'Read [the guide][guide-late].\n\n';
  assert.equal(renderChatMarkdown(before), chatMarkdownHtml(before));
  const after = `${before}[guide-late]: https://example.com/guide-late`;
  assert.match(renderChatMarkdown(after), /href="https:\/\/example.com\/guide-late"/);
  assert.equal(renderChatMarkdown(after), chatMarkdownHtml(after));
});

test('unchanged blocks come from the cache; a streamed delta renders only the tail block', (t) => {
  const sanitize = t.mock.method(DOMPurify, 'sanitize');
  const head = [
    '## Cached heading 7f3',
    'A paragraph that stays the same 7f3.',
    '- item one 7f3\n- item two 7f3',
    '```sh\necho cached-7f3\n```',
    '| k | v |\n| - | - |\n| a | 7f3 |',
  ].join('\n\n');
  const first = `${head}\n\nThe streamed tail 7f3 sta`;
  renderChatMarkdown(first);
  assert.equal(sanitize.mock.callCount(), 6, 'each non-empty block is sanitized once');
  sanitize.mock.resetCalls();
  assert.equal(renderChatMarkdown(first), chatMarkdownHtml(first));
  assert.equal(
    sanitize.mock.callCount(),
    1,
    'finished blocks are cache hits; the tail is not cached',
  );
  sanitize.mock.resetCalls();
  const next = `${first}rts here and grows.`;
  assert.equal(renderChatMarkdown(next), chatMarkdownHtml(next));
  assert.equal(sanitize.mock.callCount(), 1, 'only the tail paragraph is rendered again');
  sanitize.mock.resetCalls();
  // Once a new block starts, the finished tail is cached like the others.
  const closed = `${next}\n\nA new tail`;
  assert.equal(renderChatMarkdown(closed), chatMarkdownHtml(closed));
  assert.equal(sanitize.mock.callCount(), 2, 'the finished tail and the new tail');
  sanitize.mock.resetCalls();
  renderChatMarkdown(closed);
  assert.equal(sanitize.mock.callCount(), 1, 'the finished tail is now cached');
});

test('a code block renders highlighted once its language has loaded', async () => {
  const md = '```ts\nconst answer: number = 42;\n```';
  await preloadCodeLanguage('ts');
  const html = renderChatMarkdown(md);
  assert.match(html, /<pre[^>]*style=/, 'the highlighter themes the block');
  assert.match(html, /<span[^>]*style="[^"]*color/, 'tokens are coloured');
  assert.equal(
    html.replace(/<[^>]+>/g, '').replace('tsWrapCopy', ''),
    'const answer: number = 42;',
    'the code text is unchanged',
  );
  // An unknown language falls back to plain text rather than failing.
  await preloadCodeLanguage('not-a-language-9c1');
  assert.match(renderChatMarkdown('```not-a-language-9c1\nplain\n```'), /plain/);
});

test('with file links on, paths become workspace chips and other links stay links', () => {
  const md = [
    'See [src/a.ts:12](src/a.ts:12), [the store](services/gateway/src/store.ts#L40),',
    '`packages/x/src/y.ts:3`, [docs](https://example.com/docs), `node.js` and `npm test`.',
  ].join('\n');
  const html = renderChatMarkdown(md, { fileLinks: true });
  assert.match(
    html,
    /<a href="#" class="cm-file" data-file-path="src\/a.ts" data-file-line="12" title="src\/a.ts:12">a.ts · L12<\/a>/,
  );
  assert.match(
    html,
    /data-file-path="services\/gateway\/src\/store.ts" data-file-line="40"[^>]*>the store<\/a>/,
    'a link with its own text keeps it',
  );
  assert.match(
    html,
    /data-file-path="packages\/x\/src\/y.ts" data-file-line="3"[^>]*><code>packages\/x\/src\/y.ts:3<\/code><\/a>/,
  );
  assert.match(
    html,
    /<a target="_blank" rel="noopener noreferrer" href="https:\/\/example.com\/docs">docs<\/a>/,
  );
  assert.match(html, /<code>node.js<\/code>/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.equal(html.split('cm-file').length - 1, 3, 'exactly the three paths');
  // Off by default: hosts without a workspace keep plain links and code.
  assert.doesNotMatch(renderChatMarkdown(md), /cm-file/);
});
