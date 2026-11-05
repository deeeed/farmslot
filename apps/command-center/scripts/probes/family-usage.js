// Read-only proof for the family receipt panel. The snapshot is the real RPC/cache value.
const host = document.querySelector('family-observability');
const panel = host?.shadowRoot?.querySelector('.token-panel');
if (!panel || !host.snapshot?.usage) return { mounted: false, hash: location.hash };
const data = host.snapshot.usage;
const rect = (element) => {
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};
const sessions = [...panel.querySelectorAll('[data-session-id]')];
const rounds = [...panel.querySelectorAll('[data-round-id]')];
const shifts = [];
if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
  const observer = new PerformanceObserver((list) => {
    shifts.push(...list.getEntries().filter((entry) => !entry.hadRecentInput));
  });
  observer.observe({ type: 'layout-shift', buffered: true });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  observer.disconnect();
}
return {
  mounted: true,
  hash: location.hash,
  familyId: host.snapshot.familyId,
  selectedRunId: host.selectedRunId,
  freshness: Reflect.get(host, 'familyQuery')?.state?.status,
  canonicalSnapshot: host.snapshot === Reflect.get(host, 'familyQuery')?.state?.data?.snapshot,
  panel: rect(panel),
  scope: panel.querySelector('.token-toggle.active')?.textContent.trim(),
  totals: panel.querySelector('.token-totals')?.innerText,
  coverage: panel.querySelector('.token-subtitle')?.innerText,
  inventory: data.sessions.map(({ id, runIds, usage }) => ({
    id,
    runIds,
    runner: usage.runner,
    model: usage.actualModel,
    roles: usage.roles,
    tokens: usage.totalTokens,
    cost: usage.costUsd,
    source: usage.source,
    measuredAt: usage.measuredAt,
  })),
  canonicalContributions: data.contributions.map(({ sessionId, runId, usage }) => ({
    sessionId,
    runId,
    tokens: usage.totalTokens,
    cost: usage.costUsd,
    measuredAt: usage.measuredAt,
  })),
  sessionRows: sessions.map((row) => ({ id: row.dataset.sessionId, text: row.innerText })),
  roundRows: rounds.map((row) => ({ id: row.dataset.roundId, text: row.innerText })),
  charts: [...panel.querySelectorAll('.token-growth-frame')].map((frame) => ({
    box: rect(frame),
    label: frame.querySelector('svg')?.getAttribute('aria-label'),
    path: frame.querySelector('path')?.getAttribute('d'),
    points: [...frame.querySelectorAll('circle')].map((point) => ({
      x: Number(point.getAttribute('cx')),
      y: Number(point.getAttribute('cy')),
      namespace: point.namespaceURI,
      title: point.textContent,
    })),
  })),
  frames: [...panel.querySelectorAll('.token-table-frame')].map(rect),
  panelLayoutShift: shifts
    .filter((entry) =>
      entry.sources.some((source) => source.node === host || panel.contains(source.node)),
    )
    .reduce((sum, entry) => sum + entry.value, 0),
  layoutShiftSupported: PerformanceObserver.supportedEntryTypes.includes('layout-shift'),
  pageOverflow: document.documentElement.scrollWidth > innerWidth,
};
