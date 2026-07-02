#!/usr/bin/env node
// CDP validation: hard reload slot deep link, poll terminal attach, collect console logs.
import WebSocket from 'ws';

const CDP_PORT = process.env.FARMSLOT_CDP_PORT ?? '9323';
const TARGET_HASH =
  '#slot/macwork-mm-2?runId=7adca55b-a085-4616-ae7b-37a2f635119a&recipeRun=inherited-199ace83-b51c-4119-ba60-2b0b4cc18b6b';
const URL = `http://localhost:5175/${TARGET_HASH}`;
const MAX_WAIT_MS = 25000;

async function main() {
  const tabs = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  const tab = tabs.find((t) => t.type === 'page' && t.url?.includes('localhost:5175'));
  if (!tab) {
    console.error('no farmslot page tab on :' + CDP_PORT);
    process.exit(2);
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  let id = 0;
  const pending = new Map();
  const logs = [];

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.method === 'Log.entryAdded') {
      logs.push(msg.params.entry);
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      if (window.__fsProbeConsole) return;
      window.__fsProbeConsole = [];
      for (const level of ['log', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
          const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 600);
          window.__fsProbeConsole.push({ level, line, at: performance.now() });
          orig(...args);
        };
      }
    })();`,
  });

  const reloadAt = Date.now();
  await call('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 800));

  // Auto-login from localStorage if auth gate appears
  await call('Runtime.evaluate', {
    expression: `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = Date.now() + 8000;
      while (!document.querySelector('.auth-card') && Date.now() < deadline) await sleep(50);
      const card = document.querySelector('.auth-card');
      if (!card) return { authenticated: true };
      const token = localStorage.getItem('farmslot:gateway-token');
      const password = localStorage.getItem('farmslot:gateway-password');
      const secret = token || password;
      const mode = token ? 'token' : 'password';
      if (!secret) return { authenticated: false, reason: 'no stored creds' };
      const modeButton = Array.from(document.querySelectorAll('.auth-mode')).find(
        (b) => b.textContent?.trim()?.toLowerCase() === mode,
      );
      if (modeButton) modeButton.click();
      await sleep(50);
      const input = document.querySelector('.auth-input');
      if (!input) return { authenticated: false, reason: 'no auth input' };
      input.value = secret;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      document.querySelector('.auth-card')?.requestSubmit?.();
      while (document.querySelector('.auth-card') && Date.now() < deadline) await sleep(100);
      return { authenticated: !document.querySelector('.auth-card') };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const probeExpr = `(async () => {
    const MAX = ${MAX_WAIT_MS};
    const POLL = 100;
    const t0 = performance.now();
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
    const samples = [];
    while (performance.now() - t0 < MAX) {
      await new Promise((r) => setTimeout(r, POLL));
      const tv = deepQuery('terminal-view');
      const term = tv?._terminal;
      let nonEmpty = 0;
      if (term) {
        term.scrollToBottom();
        const rows = term.rows || 0;
        nonEmpty = Array.from({ length: rows }, (_, i) =>
          term.buffer.active.getLine(i)?.translateToString(true) ?? '',
        ).filter((l) => l.trim()).length;
      }
      samples.push({
        elapsedMs: Math.round(performance.now() - t0),
        terminal: !!tv,
        runId: tv?.runId ?? null,
        attachPhase: tv?._attachPhase ?? null,
        recovery: !!document.querySelector('.sv-recovery-overlay'),
        nonEmpty,
      });
      if (tv?._attachPhase === 'live' && nonEmpty > 0) break;
    }
    const tv = deepQuery('terminal-view');
    return {
      firstTerminalMs: samples.find((s) => s.terminal)?.elapsedMs ?? null,
      firstLiveMs: samples.find((s) => s.attachPhase === 'live')?.elapsedMs ?? null,
      firstContentMs: samples.find((s) => s.nonEmpty > 0)?.elapsedMs ?? null,
      final: {
        runId: tv?.runId ?? null,
        attachPhase: tv?._attachPhase ?? null,
        mode: tv?._mode ?? null,
        dataCount: tv?._dataCount ?? null,
      },
      timeline: samples.filter(
        (s, i, arr) =>
          i === 0 ||
          i === arr.length - 1 ||
          s.terminal !== arr[i - 1].terminal ||
          s.attachPhase !== arr[i - 1].attachPhase ||
          (s.nonEmpty > 0 && arr[i - 1].nonEmpty === 0),
      ),
    };
  })()`;

  const probe = await call('Runtime.evaluate', {
    expression: probeExpr,
    awaitPromise: true,
    returnByValue: true,
  });

  const pageLogs = await call('Runtime.evaluate', {
    expression: `window.__fsProbeConsole ?? []`,
    returnByValue: true,
  });

  const textLogs = [
    ...logs.map((e) => e.text ?? ''),
    ...(pageLogs.result?.value ?? []).map((e) => e.line ?? ''),
  ];
  const interesting = textLogs.filter((t) =>
    /\[gateway\]|\[terminal|tmux\.worker|pr\.list|change-in-update|recovery|Not connected/i.test(t),
  );

  const subscribeOk = interesting.filter((t) => /subscribed OK|terminal\.subscribe/i.test(t));
  const unsubscribe = interesting.filter((t) => /terminal\.unsubscribe/i.test(t));
  const tmuxSlow = interesting.filter((t) => /tmux\.worker\.list\s+5\d{3}ms/.test(t));
  const prSlow = interesting.filter((t) => /pr\.list\s+\d{4,}ms/.test(t));
  const litWarn = interesting.filter((t) => /change-in-update/i.test(t));

  console.log(
    JSON.stringify(
      {
        url: URL,
        reloadToProbeMs: Date.now() - reloadAt,
        probe: probe.result?.value,
        signals: {
          subscribeLines: subscribeOk.length,
          unsubscribeLines: unsubscribe.length,
          tmuxWorkerList5s: tmuxSlow.length,
          prListSlow: prSlow.length,
          litChangeInUpdate: litWarn.length,
        },
        notableConsole: interesting.slice(-60),
      },
      null,
      2,
    ),
  );

  ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});