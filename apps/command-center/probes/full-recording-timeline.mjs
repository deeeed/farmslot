// Run against an owned CDP tab on a retained Evidence review link.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [tab, output, ...options] = process.argv.slice(2);
const expectedRecipeOption = options.find((option) => option.startsWith('--expect-recipe='));
const control = options.find((option) => !option.startsWith('--expect-recipe='));
assert.ok(
  tab && output && expectedRecipeOption,
  'Usage: full-recording-timeline.mjs <@tab> <result.json> --expect-recipe=<group|none> [--check-playing | --check-page-2]',
);
const resolve = (path) => fileURLToPath(new URL(path, import.meta.url));
const cdp = (...args) =>
  execFileSync(process.execPath, [resolve('../scripts/cdp.mjs'), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const expectedGroup = expectedRecipeOption.slice('--expect-recipe='.length);
assert.ok(expectedGroup, 'Provide the retained recipe group or none');
const recipeGroup = expectedGroup === 'none' ? null : expectedGroup;
const beforeGroup = JSON.parse(
  cdp(
    'eval',
    tab,
    'return JSON.stringify(new URLSearchParams(location.hash.split("?")[1]).get("reviewRecipe"));',
  ),
);
assert.equal(beforeGroup, recipeGroup, 'Starting link points to the wrong recipe group');

const observed = JSON.parse(cdp('eval', tab, '--file', resolve('./full-recording-timeline.js')));
const params = new URLSearchParams(observed.route.split('?')[1]);
const expected = {
  path: observed.path,
  digest: observed.videoDigest,
  revision: observed.recordingRevision,
  positionMs: Math.round(observed.seek.expectedMs),
  page: '0',
  recipeGroup,
};
assert.equal(params.get('reviewRecipe'), expected.recipeGroup);
assert.equal(params.get('reviewRecording'), expected.path);
assert.equal(params.get('reviewFile'), expected.path);
assert.equal(params.get('reviewTimeline'), expected.page);
assert.equal(params.get('reviewRevision'), expected.revision);
assert.ok(params.has('reviewAt'));
assert.equal(Math.round(Number(params.get('reviewAt')) * 1000), expected.positionMs);
if (observed.requiresRecipeGroup)
  assert.ok(expected.recipeGroup, 'Recipe attempt missing from link');

cdp('reload', tab);
observed.restored = JSON.parse(
  cdp(
    'eval',
    tab,
    `const find = ${findInTree.toString()}; return await (${verifyRestoredTimeline.toString()})(${JSON.stringify(expected)});`,
  ),
);
observed.servedVideoDigest = cdp(
  'eval',
  tab,
  `const find = ${findInTree.toString()}; return await (${readServedVideoDigest.toString()})();`,
).trim();
assert.equal(observed.servedVideoDigest, expected.digest);
if (control === '--check-playing') {
  observed.pausedOnTimedLink = JSON.parse(
    cdp(
      'eval',
      tab,
      `const find = ${findInTree.toString()}; const verifyRestoredTimeline = ${verifyRestoredTimeline.toString()};
     return await (${verifyAlreadyPlayingLink.toString()})(${JSON.stringify(expected)});`,
    ),
  );
}
if (control === '--check-page-2') {
  const rows = JSON.parse(
    cdp(
      'eval',
      tab,
      `const find = ${findInTree.toString()}; return await (${openSecondPage.toString()})();`,
    ),
  );
  assert.notDeepEqual(
    rows,
    observed.rows.map(({ index }) => index),
  );
  cdp('reload', tab);
  observed.secondPage = JSON.parse(
    cdp(
      'eval',
      tab,
      `const find = ${findInTree.toString()}; return await (${verifyRestoredTimeline.toString()})(${JSON.stringify({ ...expected, page: '1', rows })});`,
    ),
  );
  assert.deepEqual(observed.secondPage.rows, rows);
}
writeFileSync(output, `${JSON.stringify(observed, null, 2)}\n`);

function findInTree(root, selector) {
  for (const element of root.querySelectorAll('*')) {
    if (element.matches(selector)) return element;
    const match = element.shadowRoot && findInTree(element.shadowRoot, selector);
    if (match) return match;
  }
}

async function readServedVideoDigest() {
  const review = find(document, 'evidence-reviewer');
  const video = find(review.shadowRoot, 'video');
  const response = await fetch(video.currentSrc);
  if (!response.ok) throw new Error('The restored video payload is unreadable');
  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  return (
    'sha256:' +
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

async function verifyAlreadyPlayingLink(expected) {
  const originalHash = location.hash;
  const reviewer = find(document, 'evidence-reviewer');
  const video = find(reviewer.shadowRoot, 'video');
  video.muted = true;
  await video.play();
  if (video.paused) throw new Error('Expected playback to begin before following a timed link');
  const positionMs = expected.positionMs + 500;
  const next = new URLSearchParams(originalHash.split('?')[1]);
  next.set('reviewAt', (positionMs / 1000).toFixed(3));
  location.hash = originalHash.split('?')[0] + '?' + next;
  const paused = await verifyRestoredTimeline({ ...expected, positionMs }, video);
  location.hash = originalHash;
  await verifyRestoredTimeline(expected, video);
  return paused;
}

async function openSecondPage() {
  const reviewer = find(document, 'evidence-reviewer');
  const disclosure = reviewer?.shadowRoot.querySelector('details.recording-timeline');
  const next = [...(disclosure?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent.trim() === 'Next steps',
  );
  if (!next || next.disabled)
    throw new Error('This retained recording has no second timeline page');
  next.click();
  await reviewer.updateComplete;
  const params = new URLSearchParams(location.hash.split('?')[1]);
  if (params.get('reviewTimeline') !== '1') throw new Error('The second page was not saved');
  const rows = [...disclosure.querySelectorAll('button[data-trace-index]')].map((row) =>
    Number(row.dataset.traceIndex),
  );
  if (!rows.length) throw new Error('The second page has no trace rows');
  return rows;
}

async function verifyRestoredTimeline(expected, existingVideo) {
  const until = Date.now() + 22000;
  do {
    const reviewer = find(document, 'evidence-reviewer');
    const root = reviewer?.shadowRoot;
    const video = root && find(root, 'video');
    const disclosure = root?.querySelector('details.recording-timeline');
    const rows = [...(disclosure?.querySelectorAll('button[data-trace-index]') ?? [])].map((row) =>
      Number(row.dataset.traceIndex),
    );
    const selection = reviewer?.selection;
    const actual = selection?.model.recordingForPath(selection?.recording?.path);
    const params = new URLSearchParams(location.hash.split('?')[1]);
    if (
      video?.readyState &&
      video.paused &&
      (!existingVideo || video === existingVideo) &&
      disclosure?.open &&
      params.get('reviewTimeline') === expected.page &&
      params.get('reviewRecipe') === expected.recipeGroup &&
      params.get('reviewRevision') === expected.revision &&
      selection?.recording?.path === expected.path &&
      actual?.videoDigest === expected.digest &&
      (!expected.rows || JSON.stringify(rows) === JSON.stringify(expected.rows)) &&
      Math.abs(video.currentTime * 1000 - expected.positionMs) <= 1
    ) {
      return {
        path: selection.recording.path,
        videoDigest: actual.videoDigest,
        positionMs: video.currentTime * 1000,
        targetMs: expected.positionMs,
        paused: video.paused,
        page: expected.page,
        recipeGroup: expected.recipeGroup,
        open: disclosure.open,
        rows,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error('Recording, recipe attempt, timeline page or seek did not restore');
}
