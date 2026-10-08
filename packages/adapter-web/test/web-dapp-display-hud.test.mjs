// Display resolution (headless, slow-mo, window placement, profile zoom) and the
// recipe HUD (state machine, runtime-file round trip, page drawing) of the
// web-dapp adapter. Ported from mm-harness's web-dapp-display-hud tests; the
// app.hud action cases (hudVisible, showAppHud) and slowMoFor stay with the actions.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { parseLaunchArgs } from '../src/web-dapp/launch.mjs';
import {
  browserDisplayArgs,
  resolveHeadless,
  resolveSlowMo,
  windowPlacement,
  writeProfileZoom,
  zoomLevel,
} from '../src/web-dapp/lib/display.mjs';
import {
  HUD_ELEMENT,
  hudRenderExpression,
  nextHudState,
  readHudState,
  writeHudState,
} from '../src/web-dapp/lib/hud.mjs';

import { policy } from './fixtures/web-dapp-policy.mjs';

const require = createRequire(import.meta.url);
const { assertMatch } = require('./fixtures/match.cjs');

process.env.RECIPE_WEB_DAPP_POLICY = policy.module;

// The expression runs in another realm: compare its results as plain data.
const draw = (expression, page) => JSON.parse(JSON.stringify(vm.runInNewContext(expression, page)));
const LAUNCH = ['--target', '/t', '--cdp-port', '9541', '--app-port', '9341'];
const LAPTOP = { left: 0, top: 38, width: 2056, height: 1251 };
const closeTo = (actual, expected, digits = 6) =>
  assert.ok(
    Math.abs(actual - expected) < 10 ** -digits / 2,
    `${actual} is not close to ${expected}`,
  );

describe('web-dapp headless resolution', () => {
  it('is headful by default', () => {
    assert.equal(resolveHeadless({ env: {} }), false);
    assertMatch(parseLaunchArgs(LAUNCH), { headless: false, headful: false });
  });

  it('reads TERMINAL_HEADLESS when nothing explicit is given', () => {
    assert.equal(resolveHeadless({ env: { TERMINAL_HEADLESS: '1' } }), true);
    assert.equal(resolveHeadless({ env: { TERMINAL_HEADLESS: 'true' } }), true);
    assert.equal(resolveHeadless({ env: { TERMINAL_HEADLESS: '0' } }), false);
    assert.equal(resolveHeadless({ env: { TERMINAL_HEADLESS: '' } }), false);
    assert.throws(
      () => resolveHeadless({ env: { TERMINAL_HEADLESS: 'maybe' } }),
      /TERMINAL_HEADLESS/,
    );
  });

  it('lets the flag win over the node and the node win over env', () => {
    assert.equal(
      resolveHeadless({ headless: true, nodeHeadless: false, env: { TERMINAL_HEADLESS: '0' } }),
      true,
    );
    assert.equal(resolveHeadless({ headful: true, env: { TERMINAL_HEADLESS: '1' } }), false);
    assert.equal(resolveHeadless({ nodeHeadless: true, env: { TERMINAL_HEADLESS: '0' } }), true);
    assert.equal(resolveHeadless({ nodeHeadless: false, env: { TERMINAL_HEADLESS: '1' } }), false);
    assert.equal(resolveHeadless({ nodeHeadful: true, env: { TERMINAL_HEADLESS: '1' } }), false);
  });

  it('keeps --headful as an accepted alias and rejects both flags together', () => {
    assertMatch(parseLaunchArgs([...LAUNCH, '--headful']), { headful: true, headless: false });
    assertMatch(parseLaunchArgs([...LAUNCH, '--headless']), { headless: true });
    assert.throws(
      () => parseLaunchArgs([...LAUNCH, '--headless', '--headful']),
      /mutually exclusive/,
    );
    assert.throws(() => resolveHeadless({ headless: true, headful: true }), /mutually exclusive/);
  });
});

describe('web-dapp slow-mo', () => {
  it('resolves flag, then node, then env, then 0', () => {
    assert.equal(resolveSlowMo({ env: {} }), 0);
    assert.equal(resolveSlowMo({ env: { TERMINAL_SLOW_MO: '250' } }), 250);
    assert.equal(resolveSlowMo({ node: 400, env: { TERMINAL_SLOW_MO: '250' } }), 400);
    assert.equal(resolveSlowMo({ flag: '100', node: 400, env: { TERMINAL_SLOW_MO: '250' } }), 100);
    assert.throws(() => resolveSlowMo({ flag: '-5' }), /--slow-mo/);
    assert.throws(() => resolveSlowMo({ env: { TERMINAL_SLOW_MO: 'fast' } }), /TERMINAL_SLOW_MO/);
  });
});

describe('web-dapp window placement', () => {
  it('puts odd CDP ports on the left half and even ports on the right half', () => {
    const left = windowPlacement({ cdpPort: 9541, env: {}, screen: LAPTOP });
    const right = windowPlacement({ cdpPort: 9542, env: {}, screen: LAPTOP });
    assertMatch(left, { x: 0, y: 38, width: 1028, height: 1251 });
    assertMatch(right, { x: 1028, y: 38, width: 1028, height: 1251 });
    assert.ok(left.x + left.width <= right.x);
  });

  it('zooms out so the page still lays out at least 1440 CSS px wide', () => {
    const { width, zoom } = windowPlacement({ cdpPort: 9541, env: {}, screen: LAPTOP });
    assert.equal(zoom, 0.7);
    assert.ok(width / zoom >= 1440);
    assert.equal(
      windowPlacement({
        cdpPort: 9541,
        env: {},
        screen: { left: 0, top: 0, width: 4000, height: 2000 },
      }).zoom,
      1,
    );
    assert.equal(
      windowPlacement({
        cdpPort: 9541,
        env: {},
        screen: { left: 0, top: 0, width: 1000, height: 800 },
      }).zoom,
      0.5,
    );
  });

  it('honours TERMINAL_WINDOW and TERMINAL_SCREEN', () => {
    assertMatch(windowPlacement({ cdpPort: 9542, env: { TERMINAL_WINDOW: '10,20,1460,900' } }), {
      x: 10,
      y: 20,
      width: 1460,
      height: 900,
      zoom: 1,
      source: 'TERMINAL_WINDOW',
    });
    assertMatch(windowPlacement({ cdpPort: 9542, env: { TERMINAL_SCREEN: '1512x945+0+33' } }), {
      x: 756,
      y: 33,
      width: 756,
      height: 945,
      source: 'TERMINAL_SCREEN',
    });
  });

  it('keeps the tall headless viewport and places a headful window', () => {
    assert.deepEqual(browserDisplayArgs({ headless: true }), [
      '--headless=new',
      '--window-size=1600,2400',
    ]);
    assert.deepEqual(
      browserDisplayArgs({
        headless: false,
        placement: { x: 1028, y: 38, width: 1028, height: 1251 },
      }),
      ['--window-position=1028,38', '--window-size=1028,1251'],
    );
  });

  it('writes the default zoom into the profile, keeping other preferences', async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'terminal-zoom-'));
    await mkdir(path.join(profile, 'Default'));
    await writeFile(
      path.join(profile, 'Default', 'Preferences'),
      JSON.stringify({ browser: { keep: 1 } }),
    );
    writeProfileZoom(profile, 0.7);
    const prefs = JSON.parse(await readFile(path.join(profile, 'Default', 'Preferences'), 'utf8'));
    assert.deepEqual(prefs.browser, { keep: 1 });
    closeTo(prefs.partition.default_zoom_level.x, zoomLevel(0.7));
    closeTo(1.2 ** prefs.partition.default_zoom_level.x, 0.7);
    writeProfileZoom(profile, 1);
    assert.equal(
      JSON.parse(await readFile(path.join(profile, 'Default', 'Preferences'), 'utf8')).partition
        .default_zoom_level.x,
      0,
    );
  });
});

describe('web-dapp HUD state', () => {
  const run = (state, node, nodeId) =>
    nextHudState(state, { title: 'Web Terminal market open and close', ...node }, nodeId);

  it('tracks the recipe, step N/M, the current intent and the last result', () => {
    let state = run(
      null,
      { status: 'running', intent: 'Open the market', progress: { current: 1, total: 4 } },
      'open',
    );
    assertMatch(state, {
      seq: 1,
      title: 'Web Terminal market open and close',
      current: { intent: 'Open the market', progress: { current: 1, total: 4 } },
      last: null,
    });
    state = run(
      state,
      { status: 'pass', intent: 'Open the market', progress: { current: 1, total: 4 } },
      'open',
    );
    assert.deepEqual(state.last, { nodeId: 'open', intent: 'Open the market', status: 'pass' });
    state = run(
      state,
      { status: 'running', intent: 'Close the position', progress: { current: 2, total: 4 } },
      'close',
    );
    assert.equal(state.current.intent, 'Close the position');
    assert.equal(state.last.status, 'pass');
    state = run(
      state,
      {
        status: 'fail',
        intent: 'Close the position',
        error: 'Selector not found: [data-testid="x"]',
        progress: { current: 2, total: 4 },
      },
      'close',
    );
    assertMatch(state.last, { status: 'fail', error: 'Selector not found: [data-testid="x"]' });
    assert.equal(state.seq, 4);
  });

  it('closes the run on recipe-complete and starts over on the next run', () => {
    let state = run(
      null,
      { status: 'running', intent: 'Step', progress: { current: 1, total: 1 } },
      'a',
    );
    state = run(
      state,
      {
        status: 'pass',
        intent: 'Recipe completed',
        progress: { current: 1, total: 1, complete: true },
      },
      'recipe-complete',
    );
    assert.equal(state.finished, 'pass');
    assert.equal(state.current.intent, 'Recipe passed');
    state = run(
      state,
      { status: 'running', intent: 'Next run', progress: { current: 1, total: 3 } },
      'b',
    );
    assertMatch(state, { seq: 3, finished: null, last: null, current: { intent: 'Next run' } });
  });

  it('round-trips through the runtime file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'terminal-hud-'));
    assert.equal(readHudState(dir), null);
    const state = run(null, { status: 'running', intent: 'x' }, 'n');
    writeHudState(dir, state);
    assert.deepEqual(readHudState(dir), state);
  });
});

// Just enough DOM for the HUD expression: elements, closed shadow roots and a
// body with text.
function fakeDocument(origin) {
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.style = {};
      this.className = '';
      this.textContent = '';
      this.parent = null;
    }
    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === 'string') {
          this.textContent += node;
          continue;
        }
        node.parent = this;
        this.children.push(node);
      }
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    attachShadow({ mode }) {
      this.shadowMode = mode;
      this.shadow = new Element('#shadow');
      return this.shadow;
    }
    querySelector(selector) {
      const tag = selector.replace(':scope > ', '').toUpperCase();
      return this.children.find((child) => child.tagName === tag) ?? null;
    }
  }
  const html = new Element('html');
  const body = new Element('body');
  body.textContent = 'Place Long';
  html.append(body);
  const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
  return {
    document: { documentElement: html, body, createElement: (tag) => new Element(tag) },
    location: { origin },
    text,
    html,
  };
}

describe('web-dapp HUD drawing', () => {
  const state = nextHudState(
    null,
    {
      title: 'trading-lifecycle',
      status: 'running',
      intent: 'Submit the market order',
      progress: { current: 3, total: 9 },
    },
    'submit',
  );

  it('draws outside <body> in a closed shadow root that ignores the pointer', () => {
    const page = fakeDocument('http://localhost:9341');
    const result = draw(hudRenderExpression(state, 'http://localhost:9341/'), page);
    assert.deepEqual(result, { hud: true, seq: 1 });
    const host = page.html.querySelector(HUD_ELEMENT);
    assert.equal(host.parent, page.html);
    assert.equal(host.shadowMode, 'closed');
    assert.equal(host.attributes['aria-hidden'], 'true');
    assert.ok(host.style.cssText.includes('pointer-events: none'));
    assert.ok(page.text(host.shadow).includes('Submit the market order'));
    assert.ok(page.text(host.shadow).includes('step 3/9'));
    assert.ok(!page.text(page.document.body).includes('Submit the market order'));
  });

  it('caps recipe text at 180 characters and draws it as text beside the RUN badge and step label', () => {
    const intent = `<img src=x onerror="alert(1)"> ${'a'.repeat(400)}`;
    const capped = nextHudState(
      null,
      { status: 'running', intent, progress: { current: 2, total: 5 } },
      'step',
    );
    assert.equal(capped.current.intent.length, 180);
    assert.ok(capped.current.intent.endsWith('…'));
    const expression = hudRenderExpression(capped, 'http://localhost:9341');
    assert.ok(!expression.includes('innerHTML'));
    const page = fakeDocument('http://localhost:9341');
    draw(expression, page);
    const host = page.html.querySelector(HUD_ELEMENT);
    assert.equal(host.shadowMode, 'closed');
    const [head, line] = host.shadow.children.find((child) => child.className === 'hud').children;
    assert.equal(head.children.find((child) => child.className === 'step').textContent, 'step 2/5');
    const [badge] = line.children;
    assert.deepEqual([badge.className, badge.textContent], ['badge running', 'RUN']);
    assert.equal(line.textContent, ` ${capped.current.intent}`);
  });

  it('is a no-op for the same state, replaces a newer one and clears on null', () => {
    const page = fakeDocument('http://localhost:9341');
    draw(hudRenderExpression(state, 'http://localhost:9341'), page);
    assertMatch(draw(hudRenderExpression(state, 'http://localhost:9341'), page), {
      unchanged: true,
    });
    const next = nextHudState(
      state,
      { status: 'pass', intent: 'Submit the market order' },
      'submit',
    );
    draw(hudRenderExpression(next, 'http://localhost:9341'), page);
    assert.equal(
      page.html.children.filter((child) => child.tagName === HUD_ELEMENT.toUpperCase()).length,
      1,
    );
    assert.deepEqual(draw(hudRenderExpression(null, 'http://localhost:9341'), page), {
      hud: false,
      cleared: true,
    });
    assert.equal(page.html.querySelector(HUD_ELEMENT), null);
  });

  it('never draws inside MetaMask pages', () => {
    const page = fakeDocument('chrome-extension://hebhblbkkdabgoldnojllkipeoacjioc');
    assert.deepEqual(draw(hudRenderExpression(state, 'http://localhost:9341'), page), {
      hud: false,
      reason: 'not-app-origin',
    });
    assert.equal(page.html.querySelector(HUD_ELEMENT), null);
  });
});
