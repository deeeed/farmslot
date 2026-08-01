/**
 * CDP probe: shared work inventory tables across backlog / roadmap / work-graphs / runs.
 * Usage: node apps/command-center/scripts/cdp.mjs eval backlog --file probes/work-inventory-table.js
 */
(() => {
  const host =
    document.querySelector('backlog-panel') ||
    document.querySelector('roadmap-panel') ||
    document.querySelector('work-graph-panel') ||
    document.querySelector('run-list');
  if (!host) {
    return { ok: false, error: 'no inventory host on this route' };
  }
  const root = host.shadowRoot || host;
  const table = root.querySelector('[data-testid="work-inventory-table"]');
  const head = root.querySelector('.work-inventory-head, [data-testid$="-head"]');
  const rows = root.querySelectorAll('.work-inventory-row, .run-card, .compact-row, .row');
  const back = root.querySelector('[data-testid="work-inventory-back"]');
  return {
    ok: Boolean(table && head),
    host: host.tagName.toLowerCase(),
    hasTable: Boolean(table),
    hasHead: Boolean(head),
    rowCount: rows.length,
    hasBack: Boolean(back),
    tableText: (table?.textContent || '').slice(0, 200),
  };
})();
