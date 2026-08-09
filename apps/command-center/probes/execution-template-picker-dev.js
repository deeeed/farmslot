// CDP probe: #dev/execution-template-picker — proves the picker's real filter,
// selection-invalidation, and empty/partial states through actual clicks
// (MANUAL-000076 AC7/AC8/AC11).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const picker = () =>
  document.querySelector('dev-harness')?.shadowRoot?.querySelector('execution-template-picker') ??
  document.querySelector('execution-template-picker');
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

const steps = {};
steps.initialPerps = read();

clickRow('fix-bug/sentry-cuf-autonomous.mobile');
await sleep(150);
steps.afterSelectPerpsRow = read();

clickPill('money-movement');
await sleep(200);
steps.moneyMovement = read();

clickPill('general');
await sleep(200);
steps.general = read();

clickPill('interactive');
await sleep(200);
steps.generalInteractive = read();

clickPill('money-movement');
await sleep(200);
steps.moneyMovementInteractive = read();

clickPill('perps');
await sleep(200);
steps.perpsInteractive = read();

clickPill('autonomous');
await sleep(200);
steps.backToPerpsAutonomous = read();

return JSON.stringify(steps, null, 1);
