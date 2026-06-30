const SLOTS = ['macwork-mm-4', 'macwork-ff-2', 'macwork-mme-4'];
const SETTLE_MS = 12000;

function deepQuery(sel, root = document) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n?.matches?.(sel)) return n;
    if (n?.shadowRoot) stack.push(n.shadowRoot);
    for (const c of n?.children || []) stack.push(c);
  }
  return null;
}

function readViewport(tv) {
  const term = tv?._terminal;
  if (!term) return { lines: [], joined: '' };
  term.scrollToBottom();
  const rows = term.rows || 0;
  const lines = Array.from(
    { length: rows },
    (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '',
  );
  return { lines, joined: lines.join('\n') };
}

function detectGarbage(joined) {
  if (!joined.trim()) return { garbage: false, reason: 'empty' };
  // Ignore tmux split separators and status padding — not operator-visible garbage.
  const stripped = joined.replace(/[─│\s]+/g, '');
  if (!stripped.trim()) return { garbage: false, reason: 'chrome-only' };
  if (/(.)\1{24,}/.test(stripped)) return { garbage: true, reason: 'repeated-char-run' };
  if (/['`*p)\\]!]{16,}/.test(stripped)) return { garbage: true, reason: 'powerline-fallback' };
  if ((joined.match(/farmslot-demo-banner/g) || []).length > 1)
    return { garbage: true, reason: 'stacked-banner' };
  return { garbage: false, reason: 'ok' };
}

async function probeSlot(slotId) {
  location.hash = `slot/${slotId}`;
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const tv = deepQuery('terminal-view');
  const { lines, joined } = readViewport(tv);
  const garbage = detectGarbage(joined);
  return {
    slotId,
    attachPhase: tv?._attachPhase ?? null,
    mode: tv?._mode ?? null,
    dataCount: tv?._dataCount ?? null,
    rows: tv?._terminal?.rows ?? null,
    nonEmptyLines: lines.filter((l) => l.trim()).length,
    garbage,
    preview: joined.slice(0, 280),
  };
}

const results = [];
for (const slot of SLOTS) results.push(await probeSlot(slot));
return JSON.stringify({ settledMs: SETTLE_MS, results }, null, 2);
