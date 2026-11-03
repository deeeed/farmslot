import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = process.env.FARMSLOT_PROOF_OUT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
assert(output && browserModule && origin && endpoint);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith(origin));
assert(page, 'Use the owned authenticated proof tab');
const runId = '32920e48-891e-4717-acd4-3cd94a4d50ff';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const until = async (read, valid, label) => {
  const deadline = Date.now() + 45000;
  for (;;) {
    const value = await read();
    if (valid(value)) return value;
    assert(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
await fs.mkdir(output, { recursive: true });
try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/#run/${runId}`, { waitUntil: 'domcontentloaded' });
  const announcement = page
    .locator('whats-new-modal')
    .getByRole('button', { name: 'Got it', exact: true });
  if (await announcement.isVisible()) await announcement.click();
  const run = page.locator('run-detail').first();
  await run.waitFor({ state: 'visible' });
  const toggle = run.locator('[data-testid="run-review-history-toggle"]');
  await toggle.waitFor({ state: 'visible' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const panel = run.locator('review-history-panel');
  await until(
    () =>
      panel.evaluate((view) => ({
        loading: view._historyLoading,
        count: view.shadowRoot.querySelectorAll('[data-round]').length,
      })),
    (value) => !value.loading && value.count > 1,
    'Recorded review history',
  );
  const snapshot = await panel.evaluate((view) => ({
    runId: view.run.id,
    rounds: [...view.shadowRoot.querySelectorAll('[data-round]')].map((round) => ({
      number: Number(round.dataset.round),
      key: round.dataset.event,
      summary: round.querySelector('summary').textContent.trim().replace(/\s+/g, ' '),
      head: round.querySelector('code[title]')?.title,
      reviewId: view.run.agentContexts?.find((actor) => actor.id === round.dataset.event)?.reviewId,
      fixes: [...round.querySelectorAll('[data-fix]')].map((fix) => ({
        key: fix.dataset.fix,
        label: fix.querySelector('summary').textContent.trim().replace(/\s+/g, ' '),
      })),
    })),
    topLevelFixes: [...view.shadowRoot.querySelectorAll('[data-fix]')].filter(
      (fix) => !fix.closest('[data-round]'),
    ).length,
  }));
  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.topLevelFixes, 0);
  assert.deepEqual(
    snapshot.rounds.map((round) => round.number),
    snapshot.rounds.map((_, index) => index + 1),
  );
  assert.equal(
    snapshot.rounds.filter(
      (round) =>
        round.head?.startsWith('29839d67') &&
        round.reviewId?.endsWith('fd032b04-3948-458d-a9c2-bd2ae013536f'),
    ).length,
    1,
    'The recovered old result appears once',
  );
  assert(
    snapshot.rounds.some((round) => round.fixes.length),
    'A review owns its following fix',
  );
  await panel.locator('[data-round]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'collapsed-rounds.png') });
  const withFix = panel
    .locator('[data-round]')
    .filter({ has: page.locator('[data-fix]') })
    .first();
  await withFix.locator(':scope > summary').click();
  const chosenKey = await withFix.getAttribute('data-event');
  await until(
    () =>
      Promise.resolve(
        new URLSearchParams(new URL(page.url()).hash.split('?')[1])
          .getAll('round')
          .includes(chosenKey),
      ),
    Boolean,
    'Round toggle URL state',
  );
  const fixDetails = withFix.locator('[data-fix]').first();
  if (!(await fixDetails.getAttribute('open')))
    await fixDetails.locator(':scope > summary').click();
  await fixDetails.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'round-with-following-fix.png') });
  const openDiff = fixDetails.getByRole('button', { name: 'Changed files and diff', exact: true });
  await openDiff.click();
  await until(
    () =>
      panel
        .locator('diff-viewer-modal')
        .evaluate((view) => ({ open: view.open, bytes: view.diffText?.length ?? 0 })),
    (value) => value.open && value.bytes > 0,
    'Following fix diff',
  );
  await panel.locator('diff-viewer-modal').locator('.dvm-close').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(
    () =>
      panel.evaluate(
        (view, key) =>
          [...view.shadowRoot.querySelectorAll('[data-round]')].find(
            (round) => round.dataset.event === key,
          )?.open,
        chosenKey,
      ),
    Boolean,
    'URL round expansion',
  );
  const refresh = panel.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.scrollIntoViewIfNeeded();
  await until(
    () => panel.evaluate((view) => view._historyLoading),
    (loading) => !loading,
    'Round artifacts restored',
  );
  const layoutProbe = await panel.evaluateHandle((view) => {
    const rects = () =>
      [...view.shadowRoot.querySelectorAll('[data-round]')].map((round) => ({
        key: round.dataset.event,
        y: round.getBoundingClientRect().top,
        height: round.getBoundingClientRect().height,
      }));
    const probe = { before: rects(), frames: 0, shifts: [], frame: 0 };
    const sample = () => {
      probe.frames++;
      const current = rects();
      if (
        current.length !== probe.before.length ||
        current.some(
          (entry, index) =>
            entry.key !== probe.before[index].key ||
            Math.abs(entry.y - probe.before[index].y) > 0.5 ||
            Math.abs(entry.height - probe.before[index].height) > 0.5,
        )
      )
        probe.shifts.push(current);
      probe.frame = requestAnimationFrame(sample);
    };
    probe.frame = requestAnimationFrame(sample);
    return probe;
  });
  let layout;
  try {
    await refresh.click();
    await until(
      () => panel.evaluate((view) => view._historyLoading),
      (loading) => !loading,
      'Refresh round artifacts',
    );
    await page.waitForTimeout(500);
    layout = await layoutProbe.evaluate((probe) => ({
      frames: probe.frames,
      shifts: probe.shifts,
    }));
    assert(layout.frames > 1);
    assert.equal(
      layout.shifts.length,
      0,
      'Refreshing artifacts must preserve round positions and heights',
    );
  } finally {
    await layoutProbe.evaluate((probe) => cancelAnimationFrame(probe.frame));
    await layoutProbe.dispose();
  }
  const acceptance = await run.locator('run-pipeline').evaluate((view) => ({
    outer: view.shadowRoot.querySelectorAll('[data-panel="run-acceptance"]').length,
    inner:
      view.shadowRoot
        .querySelector('[data-panel="run-acceptance"]')
        ?.querySelectorAll('.ac-summary').length ?? 0,
  }));
  assert.equal(acceptance.outer, 1);
  assert.equal(acceptance.inner, 0);
  await run
    .locator('run-pipeline')
    .locator('[data-panel="run-acceptance"]')
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'single-acceptance-panel.png') });
  const result = {
    status: 'PASS',
    ...snapshot,
    acceptance,
    expandedRoundRestored: true,
    layout,
    errors,
    actualControls: true,
  };
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') });
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ message: error.message, errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
