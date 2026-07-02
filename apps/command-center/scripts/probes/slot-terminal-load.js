// E2E probe: slot deep-link terminal attach latency + console/gateway log hints.
const TARGET =
  '#slot/macwork-mm-2?runId=7adca55b-a085-4616-ae7b-37a2f635119a&recipeRun=inherited-199ace83-b51c-4119-ba60-2b0b4cc18b6b';
const MAX_WAIT_MS = 20000;
const POLL_MS = 200;

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
  if (!term) return { nonEmptyLines: 0, preview: '' };
  term.scrollToBottom();
  const rows = term.rows || 0;
  const lines = Array.from(
    { length: rows },
    (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '',
  );
  const joined = lines.join('\n');
  return {
    nonEmptyLines: lines.filter((l) => l.trim()).length,
    preview: joined.slice(0, 400),
  };
}

const t0 = performance.now();
location.hash = TARGET;
const samples = [];

while (performance.now() - t0 < MAX_WAIT_MS) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const tv = deepQuery('terminal-view');
  const slotView = document.querySelector('slot-view');
  const viewport = readViewport(tv);
  const sample = {
    elapsedMs: Math.round(performance.now() - t0),
    slotView: !!slotView,
    terminal: !!tv,
    xterm: !!tv?.querySelector?.('.xterm'),
    runId: tv?.runId ?? null,
    slotId: tv?.slotId ?? null,
    attachPhase: tv?._attachPhase ?? null,
    mode: tv?._mode ?? null,
    recoveryBlocked: !!document.querySelector('.sv-recovery-overlay'),
    recoveryText: document.querySelector('.sv-recovery-overlay')?.innerText?.slice(0, 80) ?? null,
    nonEmptyLines: viewport.nonEmptyLines,
  };
  samples.push(sample);
  if (tv && tv._attachPhase === 'live' && viewport.nonEmptyLines > 0) break;
  if (tv && tv._attachPhase === 'live' && sample.elapsedMs > 8000) break;
}

const tv = deepQuery('terminal-view');
const viewport = readViewport(tv);
const firstTerminal = samples.find((s) => s.terminal) ?? null;
const firstLive = samples.find((s) => s.attachPhase === 'live') ?? null;
const firstContent = samples.find((s) => s.nonEmptyLines > 0) ?? null;

return JSON.stringify(
  {
    target: TARGET,
    totalWaitMs: Math.round(performance.now() - t0),
    firstTerminalMs: firstTerminal?.elapsedMs ?? null,
    firstLiveMs: firstLive?.elapsedMs ?? null,
    firstContentMs: firstContent?.elapsedMs ?? null,
    final: {
      runId: tv?.runId ?? null,
      attachPhase: tv?._attachPhase ?? null,
      mode: tv?._mode ?? null,
      dataCount: tv?._dataCount ?? null,
      nonEmptyLines: viewport.nonEmptyLines,
      preview: viewport.preview,
      recoveryBlocked: !!document.querySelector('.sv-recovery-overlay'),
    },
    sampleCount: samples.length,
    timeline: samples.filter(
      (_, i, arr) =>
        i === 0 ||
        i === arr.length - 1 ||
        arr[i].terminal !== arr[i - 1].terminal ||
        arr[i].attachPhase !== arr[i - 1].attachPhase ||
        (arr[i].nonEmptyLines > 0 && arr[i - 1].nonEmptyLines === 0),
    ),
  },
  null,
  2,
);