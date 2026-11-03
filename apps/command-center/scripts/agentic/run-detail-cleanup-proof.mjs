import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const phase = process.argv[2];
assert(['before', 'after'].includes(phase));
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const output = process.env.FARMSLOT_PROOF_OUT;
assert(endpoint && browserModule && origin && output);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
assert.equal(new URL(origin).hostname, '127.0.0.1');
const runId = 'ce1c5583-dd9f-4664-87f2-b64f02941ee7';
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const errors = [];
const poll = async (read, accepts, label) => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert(Date.now() < deadline, label + ': ' + JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((entry) => entry.url().startsWith(origin));
  assert(page, 'Use the existing owned mini dev harness browser');
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 500)));
  await page.goto(origin + '/#run/' + runId, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const run = page.locator('run-detail').first();
  await run.waitFor({ state: 'visible' });
  await poll(
    () => run.evaluate((view) => ({ id: view.run?.id, title: view.run?.ticketOrPr })),
    (value) => value.id === runId,
    'live run detail',
  );
  // This proof opens only local collapsible panels. It never opens a terminal or sends a command.
  const historyToggle = run.locator('[data-testid="run-review-history-toggle"]');
  await historyToggle.waitFor({ state: 'visible' });
  if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') await historyToggle.click();
  const history = run.locator('review-history-panel');
  await poll(
    () =>
      history.evaluate((view) => ({
        loading: view._historyLoading,
        initialized: Boolean(view._historyIdentity),
        count: view.shadowRoot?.querySelectorAll('[data-round]').length ?? 0,
      })),
    (value) => value.count > 0 && value.initialized && !value.loading,
    'recorded review history',
  );
  const gradeToggle = run.locator('[data-testid="run-grade-toggle"]');
  if ((await gradeToggle.getAttribute('aria-expanded')) !== 'true') await gradeToggle.click();
  const snapshot = await run.evaluate((view) => {
    const root = view.renderRoot ?? view.shadowRoot ?? view;
    const pipeline = root.querySelector('run-pipeline');
    const pipelineRoot = pipeline?.renderRoot ?? pipeline?.shadowRoot ?? pipeline;
    const history = root.querySelector('review-history-panel');
    const historyRoot = history?.shadowRoot ?? history;
    const rounds = [...historyRoot.querySelectorAll('[data-round]')].map((node) => ({
      label: Number(node.getAttribute('data-round')),
      key: node.getAttribute('data-event'),
      text: node.querySelector('summary')?.innerText,
      group: node.closest('[data-round-group]')?.getAttribute('data-round-group'),
    }));
    return {
      runId: view.run.id,
      stepPanel: Boolean(pipelineRoot.querySelector('[data-panel="run-step-progress"]')),
      transferPanel: Boolean(root.querySelector('[data-panel="run-transfers"]')),
      grade: root.querySelector('[data-panel="run-grade"]')?.innerText,
      rounds,
      groups: [...historyRoot.querySelectorAll('[data-round-group]')].map((node) => ({
        number: Number(node.getAttribute('data-round-group')),
        rounds: node.querySelectorAll('[data-round]').length,
        fixes: [...node.querySelectorAll('[data-fix]')].map((fix) => fix.getAttribute('data-fix')),
      })),
    };
  });
  await fs.writeFile(path.join(output, 'render.json'), JSON.stringify(snapshot, null, 2));
  await history.locator('[data-round]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'history.png') });
  await history.locator('[data-round]').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'latest-round.png') });
  await gradeToggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'estimate.png') });
  if (phase === 'after') {
    assert.equal(snapshot.stepPanel, false);
    assert.equal(snapshot.transferPanel, false);
    assert.match(snapshot.grade, /Task estimate/i);
    assert.match(snapshot.grade, /Task difficulty and suggested model, estimated before execution/);
    assert.deepEqual(
      snapshot.rounds.map((round) => round.label),
      snapshot.rounds.map((_round, index) => index + 1),
    );
    assert(
      snapshot.rounds.at(-1).text.includes('25c7be99'),
      'The latest reviewed head must be last',
    );
    assert.equal(snapshot.groups.length, snapshot.rounds.length);
    assert(snapshot.groups.every((group) => group.rounds === 1));
    assert(
      snapshot.groups.some((group) => group.fixes.length > 0),
      'A fix must share its round group',
    );
    const refresh = history.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.scrollIntoViewIfNeeded();
    const layout = await history.evaluateHandle((view) => {
      const root = view.shadowRoot;
      const positions = () =>
        [...root.querySelectorAll('[data-round-group]')].map((node) => ({
          key: node.getAttribute('data-round-group'),
          y: node.getBoundingClientRect().top,
          height: node.getBoundingClientRect().height,
        }));
      const probe = {
        before: positions(),
        positions,
        frames: 0,
        shifts: [],
        frame: 0,
        stop() {
          cancelAnimationFrame(this.frame);
        },
      };
      const sample = () => {
        probe.frames++;
        const current = positions();
        if (JSON.stringify(current) !== JSON.stringify(probe.before) && probe.shifts.length < 10)
          probe.shifts.push(current);
        probe.frame = requestAnimationFrame(sample);
      };
      probe.frame = requestAnimationFrame(sample);
      return probe;
    });
    await refresh.click();
    await poll(
      () => history.evaluate((view) => view._historyLoading),
      (loading) => !loading,
      'history refresh',
    );
    await history.evaluate((view) => view.updateComplete);
    const stability = await layout.evaluate((value) => {
      value.stop();
      return {
        before: value.before,
        after: value.positions(),
        frames: value.frames,
        shifts: value.shifts,
      };
    });
    await layout.dispose();
    await fs.writeFile(
      path.join(output, 'refresh-layout.json'),
      JSON.stringify(stability, null, 2),
    );
    assert(stability.frames > 0, 'The refresh must have observed real animation frames');
    assert.deepEqual(
      stability.shifts,
      [],
      'Recorded detail refresh must not shift any intermediate frame',
    );
    assert.deepEqual(
      stability.after,
      stability.before,
      'Refreshing recorded details must preserve round positions and heights',
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      phase,
      result: 'PASS',
      rounds: snapshot.rounds.map((round) => round.label),
      groups: snapshot.groups.length,
      errors,
    }),
  );
} finally {
  await browser.close();
}
