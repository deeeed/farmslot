'use strict';

/**
 * Operator slot title for headed extension Chrome.
 *
 * Chrome's window label is the active tab's document.title. Farmslot stamps the
 * extension's home page to "<slot-id> — <page title>" so operators can tell
 * which slot owns a window when several farms run side by side.
 *
 * Stamping is best-effort: missing slot context or an uninspectable tab must
 * never fail launch/readiness. A MutationObserver keeps the prefix across the
 * page's own (SPA) title resets.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/**
 * @param {unknown} value
 * @returns {string} The trimmed slot id, or '' when it is not a safe id.
 */
function sanitizeSlotId(value) {
  const slotId = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._:-]{1,64}$/u.test(slotId) ? slotId : '';
}

/**
 * Slot id from RECIPE_SLOT_ID / SLOT_ID / FARMSLOT_SLOT_ID, else from
 * `<target>/<runtimeDir>/agentic-runtime.json`; '' outside a farm slot.
 * @param {string} [target]
 * @param {string} [runtimeDir]
 * @returns {string}
 */
function readSlotId(target, runtimeDir) {
  for (const key of ['RECIPE_SLOT_ID', 'SLOT_ID', 'FARMSLOT_SLOT_ID']) {
    const value = sanitizeSlotId(process.env[key]);
    if (value) return value;
  }
  if (!target || !runtimeDir) return '';
  try {
    const runtimeContext = JSON.parse(
      fs.readFileSync(path.join(target, runtimeDir, 'agentic-runtime.json'), 'utf8'),
    );
    return sanitizeSlotId(runtimeContext.slotId);
  } catch {
    // Standalone harness users do not need a custom browser title.
    return '';
  }
}

/**
 * Serialized page-evaluation callback. Must stay a plain function (no closure).
 * `fallbackTitle` is the page's own title, used when the document has none.
 * @param {{ slotId: string, fallbackTitle?: string }} options
 * @returns {string}
 */
function applyPersistentSlotTitle({ slotId, fallbackTitle = '' }) {
  // Inline sanitize because the serialized function cannot call Node helpers.
  const id =
    typeof slotId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(slotId.trim())
      ? slotId.trim()
      : '';
  if (!id) return document.title;
  window.__farmslotSlotId = id;
  window.__farmslotSlotFallbackTitle = String(fallbackTitle || '');

  const stripSlotPrefixes = (title) => {
    const fallback = window.__farmslotSlotFallbackTitle;
    let base = String(title || fallback);
    // Accept em dash, en dash, or hyphen — historical stampers mixed them.
    for (let i = 0; i < 32; i += 1) {
      const stripped = base.replace(/^.+?\s+[—–-]\s+/u, '');
      if (stripped === base) break;
      base = stripped;
    }
    return base || fallback;
  };

  const desiredTitle = () => {
    const id = window.__farmslotSlotId;
    if (!id) return document.title;
    const base = stripSlotPrefixes(document.title);
    if (base && base !== id) return `${id} — ${base}`;
    // A bare id is this stamp's own output for an untitled page: never prefix it
    // with itself, but complete it once the page title is known.
    const fallback = window.__farmslotSlotFallbackTitle;
    return fallback ? `${id} — ${fallback}` : id;
  };

  const setTitle = () => {
    if (window.__farmslotSlotTitleLock) {
      window.__farmslotSlotTitlePending = true;
      return;
    }
    const next = desiredTitle();
    if (document.title === next) return;
    window.__farmslotSlotTitleLock = true;
    try {
      document.title = next;
    } finally {
      // Release after the title mutation is delivered so the observer cannot
      // re-enter and stack prefixes while React also mutates the DOM. If a
      // mutation arrived while locked, re-apply once after unlock.
      queueMicrotask(() => {
        window.__farmslotSlotTitleLock = false;
        if (window.__farmslotSlotTitlePending) {
          window.__farmslotSlotTitlePending = false;
          setTitle();
        }
      });
    }
  };

  setTitle();
  if (!window.__farmslotSlotTitleObserver) {
    let node = document.querySelector('title');
    if (!node) {
      node = document.createElement('title');
      (document.head || document.documentElement).appendChild(node);
    }
    window.__farmslotSlotTitleObserver = new MutationObserver(setTitle);
    // Observe only the <title> element — watching head/documentElement with
    // subtree:true re-fires on every React DOM mutation and can livelock CDP.
    window.__farmslotSlotTitleObserver.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  return document.title;
}

/**
 * @param {string} slotId
 * @param {string} [fallbackTitle]
 * @returns {string}
 */
function buildStampExpression(slotId, fallbackTitle = '') {
  const slot = sanitizeSlotId(slotId);
  if (!slot) return 'document.title';
  // Single source of truth: serialize the Playwright callback for CDP evaluate.
  const argument = JSON.stringify({ slotId: slot, fallbackTitle: String(fallbackTitle) });
  return `(${applyPersistentSlotTitle.toString()})(${argument})`;
}

function assertLocalUrl(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//u.test(url)) {
    throw new Error(`slot-title: refusing non-local URL: ${url}`);
  }
}

function assertLocalWebSocketUrl(url) {
  if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):\d+\//u.test(String(url))) {
    throw new Error(`slot-title: refusing non-local websocket URL: ${url}`);
  }
}

function httpJson(url, timeoutMs = 3000) {
  assertLocalUrl(url);
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout from ${url}`));
    });
    req.on('error', reject);
  });
}

async function cdpEvaluate(webSocketDebuggerUrl, expression, timeoutMs = 5000) {
  assertLocalWebSocketUrl(webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    // Loaded only here, so the slot-id helpers work where `ws` is not installed.
    const WebSocketImpl = globalThis.WebSocket ?? require('ws');
    const ws = new WebSocketImpl(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Best-effort timeout cleanup.
      }
      reject(new Error('timeout evaluating extension page via CDP'));
    }, timeoutMs);
    const onOpen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    };
    const onMessage = (event) => {
      const raw = event?.data ?? event;
      const msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        return;
      }
      resolve(msg.result?.result?.value ?? null);
    };
    const onError = (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `CDP websocket error while stamping slot title: ${err?.message || err?.error?.message || err?.type || 'unknown'}`,
        ),
      );
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
  });
}

function isHomePage(target, extensionId, homePage) {
  if (!target || target.type !== 'page' || typeof target.url !== 'string') return false;
  if (!target.url.startsWith(`chrome-extension://${extensionId}/`)) return false;
  return target.url.includes(`/${homePage}`);
}

/**
 * Stamp every inspectable `homePage` tab of this extension over CDP.
 * Attached tabs (no webSocketDebuggerUrl) are skipped — another client owns them.
 * @param {{ cdpPort: number, extensionId: string, homePage: string, fallbackTitle?: string, slotId?: string, target?: string, runtimeDir?: string }} options
 * @returns {Promise<{ slotId: string, stamped: number, skipped: number, titles: string[] }>}
 */
async function stampHomeTabsViaCdp(options) {
  const {
    target = process.cwd(),
    cdpPort,
    extensionId,
    homePage,
    fallbackTitle = '',
    slotId: slotIdOption,
    runtimeDir,
  } = options || {};
  const slotId = sanitizeSlotId(slotIdOption) || readSlotId(target, runtimeDir);
  const empty = { slotId: slotId || '', stamped: 0, skipped: 0, titles: [] };
  if (!slotId || !cdpPort || !extensionId || !homePage) return empty;

  let targets;
  try {
    targets = await httpJson(`http://127.0.0.1:${cdpPort}/json/list`);
  } catch {
    return empty;
  }
  if (!Array.isArray(targets)) return empty;

  const homes = targets.filter((t) => isHomePage(t, extensionId, homePage));
  const titles = [];
  let stamped = 0;
  let skipped = 0;
  const expression = buildStampExpression(slotId, fallbackTitle);

  for (const home of homes) {
    if (typeof home.webSocketDebuggerUrl !== 'string') {
      skipped += 1;
      continue;
    }
    try {
      const title = await cdpEvaluate(home.webSocketDebuggerUrl, expression);
      if (typeof title === 'string') {
        titles.push(title);
        stamped += 1;
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { slotId, stamped, skipped, titles };
}

module.exports = {
  sanitizeSlotId,
  readSlotId,
  applyPersistentSlotTitle,
  buildStampExpression,
  stampHomeTabsViaCdp,
};
