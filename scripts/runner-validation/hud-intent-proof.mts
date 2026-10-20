// Live tier: use an isolated app tab and the production HUD renderers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HUD_COLORS,
  HUD_FINISHED_FONT_SIZE,
  HUD_INTENT_FONT_SIZE,
  HUD_INTENT_LINE_HEIGHT,
  HUD_INTENT_MAX_LINES,
  HUD_PANEL_BOUNDS,
  RECIPE_INTENT_MAX_LENGTH,
} from '../../packages/protocol/src/recipe/hud-intent.js';
import {
  hudRenderExpression,
  nextHudState,
} from '../../packages/adapter-web/src/web-dapp/lib/hud.mjs';
import type { ActionExecutionContext } from '../../packages/recipe-runner/src/core/types.js';
import {
  CdpWebPage,
  createCdpWebUiTransport,
  listCdpTargets,
} from '../../packages/recipe-runner/src/runtime/cdp.js';

interface DomNode {
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

interface Measurement {
  text: string;
  width: number;
  height: number;
  scrollHeight: number;
  lineHeight: number;
  fontSize: number;
  maxLines: string;
  textOverflow: string;
  color: string;
}

const [portArg, origin, output] = process.argv.slice(2);
assert.ok(
  portArg && origin && output,
  'Usage: hud-intent-proof.mts <owned-cdp-port> <app-origin> <artifacts>',
);
const target = (await listCdpTargets('127.0.0.1', Number(portArg))).find(
  (item) => item.type === 'page' && item.url.startsWith(origin),
);
assert.ok(target, 'Isolated app tab not found');
const page = await CdpWebPage.connectToTarget(target);
await mkdir(output, { recursive: true });

// The authoring maximum (120 characters), and the step that finished before it.
const sentence =
  'Show the complete current HUD intent at its maximum length while the application stays visible';
const intent = `${sentence}${' and readable'.repeat(3)}`.slice(0, RECIPE_INTENT_MAX_LENGTH);
assert.equal(intent.length, RECIPE_INTENT_MAX_LENGTH);
const previous = 'Open the order page';

const find = (entry: DomNode, predicate: (node: DomNode) => boolean): DomNode | undefined => {
  if (predicate(entry)) return entry;
  for (const child of [...(entry.children ?? []), ...(entry.shadowRoots ?? [])]) {
    const found = find(child, predicate);
    if (found) return found;
  }
};
const attr = (entry: DomNode, key: string) => {
  const index = entry.attributes?.indexOf(key) ?? -1;
  return index < 0 ? undefined : entry.attributes?.[index + 1];
};
const ownText = (entry: DomNode) =>
  (entry.children ?? [])
    .filter((child) => child.nodeName === '#text')
    .map((child) => child.nodeValue ?? '')
    .join('');
const measure = async (node: DomNode) => {
  const resolved = await page.session.call<{ object: { objectId: string } }>('DOM.resolveNode', {
    nodeId: node.nodeId,
  });
  const measured = await page.session.call<{ result: { value: Measurement } }>(
    'Runtime.callFunctionOn',
    {
      objectId: resolved.object.objectId,
      returnByValue: true,
      functionDeclaration: `function() { const s=getComputedStyle(this),r=this.getBoundingClientRect();return {text:this.textContent,width:r.width,height:r.height,scrollHeight:this.scrollHeight,lineHeight:parseFloat(s.lineHeight),fontSize:parseFloat(s.fontSize),maxLines:s.webkitLineClamp,textOverflow:s.textOverflow,color:s.color}; }`,
    },
  );
  return measured.result.value;
};

try {
  const app = await page.evaluate(
    '({ origin: location.origin, textLength: document.body.innerText.length })',
  );
  assert.equal(app.origin, origin);
  assert.ok(app.textLength > 100, 'Application did not render');
  const transport = createCdpWebUiTransport({
    getPage: async () => CdpWebPage.connectToTarget(target),
  });
  const context: ActionExecutionContext = {
    nodeId: 'hud-proof',
    recipe: {},
    projectRoot: process.cwd(),
    artifactsDir: output,
    env: {},
    outputs: new Map(),
    getOutput: () => undefined,
    resolveProjectPath: (file) => path.resolve(file),
    resolveArtifactPath: (file) => path.resolve(output, file),
    getRunFileOffset: () => undefined,
    registerArtifact: () => {
      throw new Error('HUD rendering must not register artifacts');
    },
    logger: { info: console.info, warn: console.warn, error: console.error },
  };
  const step = (status: string, nodeId: string, copy: string, current: number) => ({
    status,
    node_id: nodeId,
    intent: copy,
    progress: { current, total: 3 },
    display: { layout: 'card' },
  });
  const receipts: unknown[] = [];
  // Terminal records at 976 CSS px. A phone-width viewport grows the card instead of cutting.
  for (const [viewport, width, height] of [
    ['recording', 976, 1040],
    ['narrow', 390, 844],
  ] as const) {
    await page.session.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const renderer of ['web', 'runner'] as const) {
      // A pass, then the next running node: the finished step sits below the intent.
      let state: ReturnType<typeof nextHudState> | null = null;
      if (renderer === 'web') {
        await transport.execute('app.hud', { clear: true }, context);
        state = nextHudState(null, step('running', 'open', previous, 1), 'open');
        state = nextHudState(state, step('pass', 'open', previous, 1), 'open');
        state = nextHudState(state, step('running', 'longest', intent, 2), 'longest');
        await page.evaluate(hudRenderExpression(state, origin));
      } else {
        await page.evaluate(hudRenderExpression(null, origin));
        await transport.execute('app.hud', step('pass', 'open', previous, 1), context);
        await transport.execute('app.hud', step('running', 'longest', intent, 2), context);
      }
      const tree = await page.session.call<{ root: DomNode }>('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const host = find(tree.root, (entry) =>
        renderer === 'web'
          ? entry.nodeName === 'MM-HARNESS-HUD'
          : attr(entry, 'id') === 'farmslot-recipe-hud',
      );
      assert.ok(host, 'HUD host missing');
      const card =
        renderer === 'web' ? find(host, (entry) => attr(entry, 'class') === 'hud') : host;
      const intentLine = find(
        host,
        (entry) => attr(entry, 'data-farmslot-hud-intent') !== undefined,
      );
      const finishedLine = find(host, (entry) => ownText(entry).startsWith('✓ '));
      assert.ok(card && intentLine && finishedLine, 'HUD card, intent or finished line missing');
      const [box, line, finished] = await Promise.all(
        [card, intentLine, finishedLine].map((node) => measure(node)),
      );
      // The intent is whole, unclamped and unclipped, at 16px on a 20px line.
      assert.equal(line.text, intent, 'Intent was cut');
      assert.equal(line.fontSize, HUD_INTENT_FONT_SIZE);
      assert.equal(line.lineHeight, HUD_INTENT_LINE_HEIGHT);
      assert.equal(line.maxLines, 'none');
      assert.notEqual(line.textOverflow, 'ellipsis');
      assert.ok(line.scrollHeight <= Math.ceil(line.height), 'Intent is clipped');
      const lines = Math.round(line.height / line.lineHeight);
      // The card is 500 CSS px, capped by the viewport (web keeps 12px a side, CDP 8px).
      const gutter = renderer === 'web' ? 24 : 16;
      assert.equal(Math.round(box.width), Math.min(HUD_PANEL_BOUNDS.card.maxWidth, width - gutter));
      if (viewport === 'recording') {
        assert.ok(lines <= HUD_INTENT_MAX_LINES, `A 120-character intent took ${lines} lines`);
      }
      // The step that just finished: one muted line at 11px.
      assert.equal(finished.text, `✓ ${previous}`);
      assert.equal(finished.fontSize, HUD_FINISHED_FONT_SIZE);
      assert.equal(Math.round(finished.height), Math.round(finished.lineHeight));
      const shot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
      });
      await writeFile(
        path.join(output, `${renderer}-${viewport}.png`),
        Buffer.from(shot.data, 'base64'),
      );
      // The step fails: it stays the main line in the fail colour, with no finished line below.
      const failure = { ...step('fail', 'longest', intent, 2), error: 'Selector not found' };
      if (renderer === 'web') {
        await page.evaluate(hudRenderExpression(nextHudState(state, failure, 'longest'), origin));
      } else {
        await transport.execute('app.hud', failure, context);
      }
      const failedTree = await page.session.call<{ root: DomNode }>('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const failedHost = find(failedTree.root, (entry) =>
        renderer === 'web'
          ? entry.nodeName === 'MM-HARNESS-HUD'
          : attr(entry, 'id') === 'farmslot-recipe-hud',
      );
      assert.ok(failedHost, 'HUD host missing after the failure');
      const failedLine = find(
        failedHost,
        (entry) => attr(entry, 'data-farmslot-hud-intent') !== undefined,
      );
      assert.ok(failedLine, 'Failing intent line missing');
      const failed = await measure(failedLine);
      assert.equal(failed.text, intent);
      const failColor = await page.evaluate(
        `(() => { const probe = document.createElement('i'); probe.style.color = ${JSON.stringify(HUD_COLORS.fail)}; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`,
      );
      assert.equal(failed.color, failColor, 'A failing main line takes the fail colour');
      assert.equal(
        find(failedHost, (entry) => /^[✓✗] /u.test(ownText(entry))),
        undefined,
        'A failing step is not repeated below itself',
      );
      const failShot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
      });
      await writeFile(
        path.join(output, `${renderer}-${viewport}-fail.png`),
        Buffer.from(failShot.data, 'base64'),
      );
      receipts.push({ viewport, renderer, lines, card: box, intent: line, finished, failed });
    }
  }
  await transport.execute('app.hud', { clear: true }, context);
  await page.evaluate(hudRenderExpression(null, origin));
  await writeFile(
    path.join(output, 'dom-layout-proof.json'),
    JSON.stringify({ app, receipts }, null, 2),
  );
} finally {
  page.session.close();
}
