// Cold-load probe: hard reload then measure terminal attach from navigation.
const TARGET =
  '#slot/macwork-mm-2?runId=7adca55b-a085-4616-ae7b-37a2f635119a&recipeRun=inherited-199ace83-b51c-4119-ba60-2b0b4cc18b6b';
const MAX_WAIT_MS = 25000;
const POLL_MS = 100;

if (!window.__probeConsole) {
  window.__probeConsole = [];
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const line = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .slice(0, 500);
      window.__probeConsole.push({ level, line, at: performance.now() });
      orig(...args);
    };
  }
}
window.__probeConsole.length = 0;

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

const navStart = performance.now();
location.href = `${location.origin}${location.pathname}${TARGET}`;
await new Promise((r) => setTimeout(r, 50));

// Auth if needed
const authDeadline = navStart + 8000;
while (document.querySelector('.auth-card') && performance.now() < authDeadline) {
  await new Promise((r) => setTimeout(r, 100));
}

const samples = [];
const t0 = performance.now();

while (performance.now() - t0 < MAX_WAIT_MS) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const tv = deepQuery('terminal-view');
  const viewport = readViewport(tv);
  const sample = {
    elapsedMs: Math.round(performance.now() - t0),
    terminal: !!tv,
    xterm: !!deepQuery('.xterm'),
    runId: tv?.runId ?? null,
    attachPhase: tv?._attachPhase ?? null,
    mode: tv?._mode ?? null,
    recoveryBlocked: !!document.querySelector('.sv-recovery-overlay'),
    nonEmptyLines: viewport.nonEmptyLines,
  };
  samples.push(sample);
  if (tv && tv._attachPhase === 'live' && viewport.nonEmptyLines > 0) break;
}

const tv = deepQuery('terminal-view');
const viewport = readViewport(tv);
const logs = (window.__probeConsole || []).filter(
  (e) =>
    /\[gateway\]|\[terminal|tmux\.worker|pr\.list|change-in-update|recovery/i.test(e.line),
);

const subscribeCount = logs.filter((e) => /terminal\.subscribe|subscribed OK/i.test(e.line)).length;
const unsubscribeCount = logs.filter((e) => /terminal\.unsubscribe/i.test(e.line)).length;
const tmuxWorkerListSlow = logs.filter((e) => /tmux\.worker\.list\s+5\d{3}ms/.test(e.line));
const prListSlow = logs.filter((e) => /pr\.list\s+\d{4,}ms/.test(e.line));

return JSON.stringify(
  {
    coldLoad: true,
    target: TARGET,
    totalWaitMs: Math.round(performance.now() - t0),
    firstTerminalMs: samples.find((s) => s.terminal)?.elapsedMs ?? null,
    firstLiveMs: samples.find((s) => s.attachPhase === 'live')?.elapsedMs ?? null,
    firstContentMs: samples.find((s) => s.nonEmptyLines > 0)?.elapsedMs ?? null,
    final: {
      runId: tv?.runId ?? null,
      attachPhase: tv?._attachPhase ?? null,
      mode: tv?._mode ?? null,
      dataCount: tv?._dataCount ?? null,
      nonEmptyLines: viewport.nonEmptyLines,
      preview: viewport.preview,
      recoveryBlocked: !!document.querySelector('.sv-recovery-overlay'),
    },
    rpcSignals: {
      subscribeCount,
      unsubscribeCount,
      tmuxWorkerListSlow: tmuxWorkerListSlow.map((e) => e.line),
      prListSlow: prListSlow.map((e) => e.line),
    },
    notableLogs: logs.slice(-40).map((e) => ({ ms: Math.round(e.at), level: e.level, line: e.line })),
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