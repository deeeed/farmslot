// CDP probe: #dev/execution-template-picker — proves the picker's real filter,
// selection-invalidation, and empty/partial states through actual clicks
// (MANUAL-000076 AC7/AC8/AC11). Self-checking: any expectation mismatch throws,
// so a silent regression fails the probe instead of hiding in the JSON dump.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// dev-harness renders light DOM; the picker itself is the only shadow root.
const picker = () => {
  const element = document.querySelector('execution-template-picker');
  if (!element)
    throw new Error(
      'execution-template-picker not mounted — open #dev/execution-template-picker first',
    );
  return element;
};
const read = () => {
  const sr = picker().shadowRoot;
  const text = (selector) =>
    sr.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  return {
    count: text('[data-testid=picker-result-count]'),
    rows: [...sr.querySelectorAll('tr.row')].map((row) => ({
      id: row.querySelector('.tpl-id')?.textContent?.trim(),
      source: row.children[1]?.textContent?.trim(),
      selected: row.classList.contains('selected'),
    })),
    empty: text('[data-testid=picker-empty]'),
    invalid: text('[data-testid=picker-selection-invalid]'),
    summary: text('[data-testid=picker-selection-summary]'),
    notices: [...sr.querySelectorAll('[data-testid=picker-source-notice]')].map((node) =>
      node.textContent.replace(/\s+/g, ' ').trim(),
    ),
  };
};
const clickPill = (label) => {
  const target = [...picker().shadowRoot.querySelectorAll('button.pill')].find(
    (pill) => pill.textContent.trim() === label,
  );
  if (!target) throw new Error(`pill not found: ${label}`);
  target.click();
};
const clickRow = (id) => {
  const row = [...picker().shadowRoot.querySelectorAll('tr.row')].find(
    (candidate) => candidate.querySelector('.tpl-id')?.textContent?.trim() === id,
  );
  if (!row) throw new Error(`row not found: ${id}`);
  row.click();
};
const expect = (step, condition, message) => {
  if (!condition) throw new Error(`[${step}] ${message}`);
};

const steps = {};
const capture = async (name, checks) => {
  await sleep(200);
  const state = read();
  steps[name] = state;
  checks(state);
  return state;
};

await capture('initialPerps', (s) => {
  expect('initialPerps', s.count.startsWith('3 compatible'), `count=${s.count}`);
  expect('initialPerps', s.rows.length === 3 && !s.empty, 'expected 3 rows, no empty state');
  expect(
    'initialPerps',
    s.notices.some((n) => n.includes('team:money-movement: domain-restricted')),
    `notices=${JSON.stringify(s.notices)}`,
  );
});

clickRow('fix-bug/sentry-cuf-autonomous.mobile');
await capture('afterSelectPerpsRow', (s) => {
  const selected = s.rows.find((row) => row.selected);
  expect(
    'afterSelectPerpsRow',
    selected?.id === 'fix-bug/sentry-cuf-autonomous.mobile',
    'perps row selected',
  );
  expect('afterSelectPerpsRow', s.summary?.includes('explicit'), `summary=${s.summary}`);
});

clickPill('money-movement');
await capture('moneyMovement', (s) => {
  expect('moneyMovement', s.count.includes('domain: money-movement'), `count=${s.count}`);
  expect(
    'moneyMovement',
    s.rows.some((row) => row.source === 'team:money-movement'),
    'settlement row present',
  );
  expect('moneyMovement', s.invalid !== null, 'stale perps selection flagged invalid');
  expect(
    'moneyMovement',
    s.notices.some((n) => n.includes('team:perps: domain-restricted')),
    `notices=${JSON.stringify(s.notices)}`,
  );
});

clickPill('general');
await capture('general', (s) => {
  expect('general', s.rows.length === 2, `rows=${s.rows.length}`);
  expect(
    'general',
    s.invalid?.includes('domain: general · mode: autonomous'),
    `invalid=${s.invalid}`,
  );
});

clickPill('interactive');
await capture('generalInteractive', (s) => {
  expect(
    'generalInteractive',
    s.empty === 'No compatible execution template for domain: general · mode: interactive.',
    `empty=${s.empty}`,
  );
  expect('generalInteractive', s.rows.length === 0, 'no rows in empty state');
});

clickPill('money-movement');
await capture('moneyMovementInteractive', (s) => {
  expect(
    'moneyMovementInteractive',
    s.rows.length === 1 && s.rows[0].id === 'fix-bug/settlement-interactive.mobile',
    `rows=${JSON.stringify(s.rows)}`,
  );
});

clickPill('perps');
await capture('perpsInteractive', (s) => {
  expect(
    'perpsInteractive',
    s.empty === 'No compatible execution template for domain: perps · mode: interactive.',
    `empty=${s.empty}`,
  );
});

clickPill('autonomous');
await capture('backToPerpsAutonomous', (s) => {
  const selected = s.rows.find((row) => row.selected);
  expect(
    'backToPerpsAutonomous',
    selected?.id === 'fix-bug/sentry-cuf-autonomous.mobile' && s.invalid === null,
    'selection restored and invalid cleared',
  );
});

return JSON.stringify({ pass: true, steps }, null, 1);
