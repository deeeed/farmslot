'use strict';

// Hermetic: pure helpers plus a local CDP/WebSocket stub that evaluates the stamp
// expression in a fake document. No live Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { afterEach, describe, it } = require('node:test');

const { WebSocketServer } = require('ws');

const {
  applyPersistentSlotTitle,
  buildStampExpression,
  readSlotId,
  sanitizeSlotId,
  stampHomeTabsViaCdp,
} = require('../src/slot-title.cjs');

const SLOT_ENV = ['RECIPE_SLOT_ID', 'SLOT_ID', 'FARMSLOT_SLOT_ID'];

afterEach(() => {
  for (const key of SLOT_ENV) delete process.env[key];
});

// A document whose <title> mutations reach MutationObservers synchronously.
// `deferMicrotasks` collects queued microtasks so a test can run them by hand.
function fakePage(initialTitle, { deferMicrotasks = false } = {}) {
  const titleEl = { childNodes: [] };
  const observers = [];
  const deferred = [];
  let title = initialTitle;
  const document = {
    get title() {
      return title;
    },
    set title(next) {
      title = String(next);
      for (const observer of observers) observer.cb();
    },
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    querySelector: (selector) => (selector === 'title' ? titleEl : null),
    createElement: () => titleEl,
  };
  const window = {};
  const context = {
    window,
    document,
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {
        observers.push(this);
      }
    },
    queueMicrotask: deferMicrotasks ? (fn) => deferred.push(fn) : (fn) => queueMicrotask(fn),
    String,
  };
  context.globalThis = context;
  vm.createContext(context);
  return { context, document, window, deferred };
}

describe('slot-title helpers', () => {
  it('accepts only safe slot ids', () => {
    assert.equal(sanitizeSlotId('macwork-mmedev-2'), 'macwork-mmedev-2');
    assert.equal(sanitizeSlotId(' bad id '), '');
    assert.equal(sanitizeSlotId('a'.repeat(65)), '');
    assert.equal(sanitizeSlotId('slot<script>'), '');
    assert.equal(sanitizeSlotId('../x'), '');
    assert.equal(sanitizeSlotId(7), '');
  });

  it('reads the slot id from the environment, then the runtime context file', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-title-'));
    try {
      fs.mkdirSync(path.join(target, 'temp/runtime'), { recursive: true });
      fs.writeFileSync(
        path.join(target, 'temp/runtime/agentic-runtime.json'),
        '{"slotId":"from-runtime-json"}',
      );
      process.env.RECIPE_SLOT_ID = 'from-env';
      assert.equal(readSlotId('/tmp/nope', 'temp/runtime'), 'from-env');
      delete process.env.RECIPE_SLOT_ID;
      assert.equal(readSlotId(target, 'temp/runtime'), 'from-runtime-json');
      assert.equal(readSlotId(target, 'missing'), '');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('serializes the page callback for CDP with the slot and fallback title', () => {
    const expression = buildStampExpression('mmedev-2', 'Product');
    assert.match(expression, /mmedev-2/u);
    assert.match(expression, /"fallbackTitle":"Product"/u);
    assert.match(expression, /MutationObserver/u);
    assert.match(expression, /applyPersistentSlotTitle/u);
    assert.equal(buildStampExpression(''), 'document.title');
  });
});

describe('applyPersistentSlotTitle', () => {
  it('stamps the same title through the page callback and the CDP expression', () => {
    const direct = fakePage('Product');
    const viaCallback = vm.runInContext(
      `(${applyPersistentSlotTitle.toString()})(${JSON.stringify({ slotId: 'slot-a', fallbackTitle: 'Product' })})`,
      direct.context,
    );
    const viaCdp = vm.runInContext(
      buildStampExpression('slot-a', 'Product'),
      fakePage('Product').context,
    );
    assert.equal(viaCallback, 'slot-a — Product');
    assert.equal(viaCdp, viaCallback);
  });

  it('collapses already-stacked slot prefixes', () => {
    const page = fakePage('slot-a — slot-a – slot-b - Product');
    assert.equal(
      vm.runInContext(buildStampExpression('slot-a', 'Product'), page.context),
      'slot-a — Product',
    );
  });

  it('uses the fallback title for an untitled page, and the bare slot id without one', () => {
    assert.equal(
      vm.runInContext(buildStampExpression('slot-a', 'Product'), fakePage('').context),
      'slot-a — Product',
    );
    assert.equal(vm.runInContext(buildStampExpression('slot-a'), fakePage('').context), 'slot-a');
  });

  it('re-applies a title reset that arrives while the observer is locked', () => {
    const page = fakePage('Product', { deferMicrotasks: true });
    vm.runInContext(buildStampExpression('slot-a', 'Product'), page.context);
    assert.equal(page.document.title, 'slot-a — Product');
    assert.equal(page.window.__farmslotSlotTitleLock, true);
    // The page resets its title before the unlock microtask runs.
    page.document.title = 'Product';
    assert.equal(page.window.__farmslotSlotTitlePending, true);
    assert.equal(page.document.title, 'Product');
    while (page.deferred.length > 0) page.deferred.shift()();
    assert.equal(page.document.title, 'slot-a — Product');
    assert.equal(page.window.__farmslotSlotTitlePending, false);
    assert.equal(page.window.__farmslotSlotTitleLock, false);
  });
});

describe('stampHomeTabsViaCdp', () => {
  it('stamps the inspectable home tab over CDP and the observer keeps the prefix', async () => {
    const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const page = fakePage('Product');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        try {
          const value = vm.runInContext(String(message.params.expression), page.context);
          socket.send(
            JSON.stringify({ id: message.id, result: { result: { type: typeof value, value } } }),
          );
        } catch (error) {
          socket.send(JSON.stringify({ id: message.id, error: { message: error.message } }));
        }
      });
    });
    const wsUrl = `ws://127.0.0.1:${wss.address().port}/devtools/page/home-1`;
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          {
            id: 'home-1',
            type: 'page',
            url: `chrome-extension://${extensionId}/home.html`,
            webSocketDebuggerUrl: wsUrl,
          },
          {
            id: 'other',
            type: 'page',
            url: `chrome-extension://${extensionId}/popup.html`,
            webSocketDebuggerUrl: wsUrl,
          },
          { id: 'attached', type: 'page', url: `chrome-extension://${extensionId}/home.html#x` },
        ]),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await stampHomeTabsViaCdp({
        cdpPort: server.address().port,
        extensionId,
        homePage: 'home.html',
        fallbackTitle: 'Product',
        slotId: 'slot-a',
      });
      assert.deepEqual(result, {
        slotId: 'slot-a',
        stamped: 1,
        skipped: 1,
        titles: ['slot-a — Product'],
      });
      page.document.title = 'Product';
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(page.document.title, 'slot-a — Product');
    } finally {
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does nothing outside a slot or without a home page', async () => {
    const empty = { slotId: '', stamped: 0, skipped: 0, titles: [] };
    assert.deepEqual(
      await stampHomeTabsViaCdp({ cdpPort: 1, extensionId: 'x', homePage: 'home.html' }),
      empty,
    );
    assert.deepEqual(
      await stampHomeTabsViaCdp({ cdpPort: 1, extensionId: 'x', homePage: '', slotId: 's' }),
      {
        ...empty,
        slotId: 's',
      },
    );
  });
});
