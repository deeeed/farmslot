// Live tier: use an isolated app tab and the production HUD renderers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

interface IntentMeasurement {
  text: string;
  height: number;
  scrollHeight: number;
  lineHeight: number;
  maxLines: string;
  overflow: string;
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
try {
  await page.session.call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const app = await page.evaluate(
    '({ origin: location.origin, textLength: document.body.innerText.length })',
  );
  assert.equal(app.origin, origin);
  assert.ok(app.textLength > 100, 'Application did not render');
  const intent = 'Show the complete HUD intent on two lines while the application remains visible.';
  const node = {
    status: 'running',
    intent,
    progress: { current: 1, total: 2 },
    display: { layout: 'card' },
  };
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
  let webState: ReturnType<typeof nextHudState> | null = null;
  const receipts: unknown[] = [];
  for (const renderer of ['web', 'runner']) {
    for (const [variant, copy] of [
      ['two-lines', intent],
      ['overflow', intent.repeat(4)],
    ]) {
      if (renderer === 'web') {
        webState = nextHudState(webState, { ...node, intent: copy }, 'hud-proof');
        await page.evaluate(hudRenderExpression(webState, origin));
      } else {
        await page.evaluate(hudRenderExpression(null, origin));
        await transport.execute('app.hud', { ...node, intent: copy }, context);
      }
      const tree = await page.session.call<{ root: DomNode }>('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const find = (entry: DomNode, predicate: (node: DomNode) => boolean): DomNode | undefined => {
        if (predicate(entry)) return entry;
        for (const child of [...(entry.children ?? []), ...(entry.shadowRoots ?? [])]) {
          const found = find(child, predicate);
          if (found) return found;
        }
      };
      const attr = (entry: DomNode, key: string) => {
        const index = entry.attributes?.indexOf(key) ?? -1;
        return index < 0 ? '' : entry.attributes[index + 1];
      };
      const host = find(tree.root, (entry) =>
        renderer === 'web'
          ? entry.nodeName === 'MM-HARNESS-HUD'
          : attr(entry, 'id') === 'farmslot-recipe-hud',
      );
      assert.ok(host, 'HUD host missing');
      const line = find(
        host,
        (entry) =>
          attr(entry, 'class') === 'intent' ||
          (entry.nodeName === 'DIV' && attr(entry, 'style').includes('-webkit-line-clamp: 2')),
      );
      assert.ok(line, 'Shared two-line layout not applied');
      const resolved = await page.session.call<{ object: { objectId: string } }>(
        'DOM.resolveNode',
        { nodeId: line.nodeId },
      );
      const measured = await page.session.call<{ result: { value: IntentMeasurement } }>(
        'Runtime.callFunctionOn',
        {
          objectId: resolved.object.objectId,
          returnByValue: true,
          functionDeclaration: `function() { const s=getComputedStyle(this),r=this.getBoundingClientRect();return {text:this.textContent,height:r.height,scrollHeight:this.scrollHeight,lineHeight:parseFloat(s.lineHeight),maxLines:s.webkitLineClamp,overflow:s.overflow}; }`,
        },
      );
      const value = measured.result.value;
      assert.equal(value.maxLines, '2');
      assert.equal(value.overflow, 'hidden');
      assert.equal(value.height, 2 * value.lineHeight, 'Intent should occupy two visible lines');
      assert.ok(value.text.includes(copy), 'Intent was cut before layout');
      if (variant === 'overflow') assert.ok(value.scrollHeight > value.height);
      const shot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
      });
      await writeFile(
        path.join(output, `${renderer}-${variant}.png`),
        Buffer.from(shot.data, 'base64'),
      );
      receipts.push({ renderer, variant, ...value });
    }
    await transport.execute('app.hud', { clear: true }, context);
  }
  await writeFile(
    path.join(output, 'dom-layout-proof.json'),
    JSON.stringify({ app, receipts }, null, 2),
  );
} finally {
  page.session.close();
}
