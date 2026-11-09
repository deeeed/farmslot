// Scroll behaviour of a long streaming timeline whose rows skip layout off screen
// (content-visibility). Route: #dev/native-session?replay=stream, freshly loaded.
// Checks: a reader who scrolled up is not pulled down and gets Jump to latest; the jump lands at
// the end; collapsing a fold keeps its toggle in place; text search finds an off-screen row; the
// streamed message matches a full markdown parse.
const dev = document.querySelector('native-session-dev');
const root = () => dev?.shadowRoot?.querySelector('native-session-view')?.shadowRoot;
const timeline = () => root()?.querySelector('.timeline');
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const distance = (t) => Math.round(t.scrollHeight - t.scrollTop - t.clientHeight);
let end = Date.now() + 20000;
while (Date.now() < end && !(timeline()?.querySelectorAll(':scope > article').length >= 300))
  await sleep(100);
const t = timeline();
if (!t) throw new Error('Timeline did not render');
await frames();
const atStart = distance(t);

// Jump to latest while streaming.
const output = dev.shadowRoot.querySelector('[data-testid="native-stream-cost"]');
dev.shadowRoot.querySelector('[data-testid="native-stream-start"]').click();
await sleep(800);
const followedWhileStreaming = distance(t);
t.scrollTop = 0;
await sleep(1500);
const scrolledUp = { scrollTop: t.scrollTop, distance: distance(t) };
const jump = root().querySelector('[data-testid="native-jump-latest"]');
const jumpLabel = jump?.textContent.trim();
jump?.click();
await frames();
const afterJump = distance(t);
await sleep(600);
const followingAfterJump = distance(t);
end = Date.now() + 60000;
while (Date.now() < end && !output.textContent.trim().startsWith('{')) await sleep(250);
await frames();
const afterStream = distance(t);

// Collapse a fold in the middle of the timeline: its toggle stays where the reader saw it.
const toggles = [...t.querySelectorAll('[data-testid="native-work-fold"]')];
const toggle = toggles[Math.floor(toggles.length / 2)];
toggle.scrollIntoView({ block: 'center' });
await frames();
if (toggle.getAttribute('aria-expanded') !== 'true') {
  toggle.click();
  await frames();
}
const expandedHidden = toggle.closest('article').previousElementSibling?.hidden;
const before = toggle.getBoundingClientRect().top;
toggle.click();
await frames();
await frames();
const fold = {
  expandedHidden,
  collapsed: toggle.getAttribute('aria-expanded') === 'false',
  movedPx: Math.round((toggle.getBoundingClientRect().top - before) * 10) / 10,
};

// Text search finds a row that is off screen and skipped. window.find selects the match but, with
// or without content-visibility, does not scroll the timeline: Cmd+F itself is not driven here.
t.scrollTop = t.scrollHeight;
await frames();
const target = [...t.querySelectorAll(':scope > article.assistant')].find((a) =>
  a.textContent.includes('Turn 3: what changed'),
);
const skippedBefore = target.getBoundingClientRect().bottom < t.getBoundingClientRect().top;
getSelection().removeAllRanges();
const found = window.find('Turn 3: what changed', false, false, true);
const [range] = getSelection().getComposedRanges({ shadowRoots: [root()] });
const findReached = Boolean(range && target.contains(range.startContainer));

// The streamed message, rendered by block, equals a full parse of the same text.
const markdown = await import('/src/utils/markdown.ts');
const { default: DOMPurify } = await import('/@id/dompurify');
const message = [...t.querySelectorAll(':scope > article.assistant chat-message')].at(-1).message;
let mismatches = 0;
for (let at = 1; at <= message.content.length; at += 31) {
  const md = message.content.slice(0, at);
  const full = DOMPurify.sanitize(markdown.chatMarkdownHtml(md), { ADD_ATTR: ['target'] });
  if (markdown.renderChatMarkdown(md) !== full) mismatches++;
}
const whole = DOMPurify.sanitize(markdown.chatMarkdownHtml(message.content), {
  ADD_ATTR: ['target'],
});

const result = {
  atStart,
  followedWhileStreaming,
  scrolledUp,
  jumpLabel,
  afterJump,
  followingAfterJump,
  afterStream,
  fold,
  find: { skippedBefore, found, findReached },
  markdown: {
    prefixesChecked: Math.ceil(message.content.length / 31),
    mismatches,
    wholeMatches: markdown.renderChatMarkdown(message.content) === whole,
  },
};
const pass =
  atStart <= 1 &&
  followedWhileStreaming <= 1 &&
  scrolledUp.distance > 1000 &&
  Boolean(jumpLabel) &&
  afterJump <= 1 &&
  followingAfterJump <= 1 &&
  afterStream <= 1 &&
  fold.collapsed &&
  Math.abs(fold.movedPx) <= 1 &&
  skippedBefore &&
  findReached &&
  mismatches === 0 &&
  result.markdown.wholeMatches;
if (!pass) throw new Error(`Timeline scroll check failed: ${JSON.stringify(result)}`);
return { pass, ...result };
