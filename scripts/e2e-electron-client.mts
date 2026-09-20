#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Run against an already-started Electron app and an isolated real gateway.
// The fixture must disable orchestration and own the supplied project and slot.
// This script never starts or stops the operator's gateway, browser, or tmux.
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? 'temp/electron-client-live');
const gatewayUrl = process.env.FARMSLOT_GATEWAY ?? 'ws://127.0.0.1:8977';
const cdpPort = process.env.FARMSLOT_CDP_PORT ?? '9473';
const slot = process.env.FARMSLOT_ELECTRON_TEST_SLOT ?? 'electron-validation';
const project = process.env.FARMSLOT_ELECTRON_TEST_PROJECT ?? 'desktop-validation';
const sourceFile = process.env.FARMSLOT_ELECTRON_TEST_FILE ?? 'package.json';
assert(['localhost', '127.0.0.1'].includes(new URL(gatewayUrl).hostname));
assert.notEqual(new URL(gatewayUrl).port, '7777', 'Use an isolated gateway');
assert.notEqual(cdpPort, '9323', 'Use the Electron validation CDP port');
const token =
  process.env.FARMSLOT_GATEWAY_TOKEN ??
  (await readFile(path.join(root, '.env.local-auth'), 'utf8'))
    .match(/^FARMSLOT_GATEWAY_TOKEN=(.+)$/m)?.[1]
    .replace(/^['"]|['"]$/g, '');
assert(token, 'Set FARMSLOT_GATEWAY_TOKEN for the isolated gateway');
await mkdir(evidence, { recursive: true });
const environment = {
  ...process.env,
  FARMSLOT_CDP_PORT: cdpPort,
  FARMSLOT_GATEWAY: gatewayUrl,
  FARMSLOT_GATEWAY_TOKEN: token,
};
function cdp(...args: string[]) {
  try {
    return execFileSync(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' },
    ).trim();
  } catch (error) {
    // execFileSync's message includes argv, which can contain the test credential.
    // Retain the failed operation without copying credential-bearing arguments.
    throw new Error(
      `CDP ${args[0]} failed: ${String((error as { stderr?: unknown }).stderr ?? '').replaceAll(token!, '[redacted]')}`,
    );
  }
}
// Read-only traversal. Controls are changed only by the committed CDP input helpers.
const walk = `function find(selector,root=document){const found=root.querySelector(selector);if(found)return found;for(const el of root.querySelectorAll('*'))if(el.shadowRoot){const result=find(selector,el.shadowRoot);if(result)return result;}return null;}`;
function evaluate(body: string) {
  return JSON.parse(cdp('eval', '-', walk + `return {value:(()=>{${body}})()};`)).value;
}
async function waitFor(label: string, predicate: () => unknown) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function visible(selector: string) {
  await waitFor(selector, () =>
    evaluate(
      `const el=find(${JSON.stringify(selector)});return el && el.getClientRects().length > 0;`,
    ),
  );
}
function click(selector: string) {
  cdp('click', '-', selector);
}
function fill(selector: string, value: string) {
  const controlPath = evaluate(`function locate(root=document,prefix='') {
    if(root.querySelector(${JSON.stringify(selector)}))return prefix+${JSON.stringify(selector)};
    for(const el of root.querySelectorAll('*'))if(el.shadowRoot){const result=locate(el.shadowRoot,prefix+el.tagName.toLowerCase()+' >>> ');if(result)return result;}
    return null;
  } return locate();`);
  assert(controlPath, `Input missing: ${selector}`);
  cdp('fill', '-', controlPath, value);
}
function rpc(method: string, params = {}) {
  return JSON.parse(cdp('gateway', method, JSON.stringify(params)));
}
function screenshot(name: string) {
  cdp('screenshot', '-', path.join(evidence, `${name}.png`));
}
const pages = JSON.parse(cdp('tabs')).filter((tab: { type: string }) => tab.type === 'page');
assert.equal(pages.length, 1, 'Use a dedicated Electron process with one window');
assert.match(evaluate('return navigator.userAgent;'), /Electron\//);
const origin = new URL(pages[0].url).origin;
assert.equal(new URL(origin).hostname, '127.0.0.1');
async function protocol(method: string, params = {}, whileAttached?: () => Promise<void>) {
  const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  try {
    await once(socket, 'open');
    const response = once(socket, 'message', { signal: AbortSignal.timeout(10_000) });
    socket.send(JSON.stringify({ id: 1, method, params }));
    const [raw] = await response;
    const message = JSON.parse(String(raw));
    assert(!message.error, JSON.stringify(message.error));
    await whileAttached?.();
    return message.result;
  } finally {
    socket.close();
  }
}
async function navigate(route: string) {
  cdp('goto', origin + route);
}
async function configure(secret: string) {
  await navigate('/settings');
  await visible('#gateway-url');
  fill('#gateway-url', gatewayUrl);
  cdp('select', '-', '#auth-mode', 'token');
  fill('#secret', secret);
  click('#connection-form button[type="submit"]');
  await waitFor('saved connection opens Command Center', () =>
    evaluate('return location.pathname === "/cc/";'),
  );
}
async function connected() {
  await waitFor('connected fleet', () =>
    evaluate(
      `return find('farm-app')?.connection === 'connected' && find('fleet-canvas')?.slots?.some(slot => slot.slot === ${JSON.stringify(slot)});`,
    ),
  );
}
const result: Record<string, unknown> = { gateway: gatewayUrl, slot, project, checks: [] };
const checks = result.checks as string[];
let itemId: string | undefined;
try {
  const fleet = rpc('fleet.status');
  assert(JSON.stringify(fleet).includes(slot), 'The isolated fixture slot must exist');
  await configure('invalid-electron-validation-token');
  await visible('.auth-error');
  screenshot('rejected-credential');
  checks.push('invalid credential rejected');

  await configure(token);
  await connected();
  if (evaluate(`return find('whats-new-modal')?.open;`)) click('button.primary');
  screenshot('connected-fleet');
  checks.push('settings save and authenticated fleet');

  // Backlog is an opt-in alpha route. Enable it through the actual preferences UI.
  await navigate('/cc/#config/settings');
  const alphaToggle = '.cp-section:last-child .cp-switch-row input[type="checkbox"]';
  await visible(alphaToggle);
  if (!evaluate(`return find(${JSON.stringify(alphaToggle)}).checked;`)) click(alphaToggle);
  await navigate('/cc/#backlog');
  await visible('.filter-toolbar-actions > button');
  click('.filter-toolbar-actions > button');
  await visible('[data-testid="backlog-create-metadata-title"]');
  click(`[data-testid="backlog-create-metadata-project-options-${project}"]`);
  click('[data-testid="backlog-create-metadata-source-manual"]');
  const title = `Electron validation ${Date.now()}`;
  fill('[data-testid="backlog-create-metadata-title"]', title);
  click('.create-panel form .actions > button');
  await waitFor('backlog creation persisted', () => {
    itemId = rpc('backlog.list', { project }).items.find(
      (item: { title: string }) => item.title === title,
    )?.id;
    return itemId;
  });
  screenshot('created-backlog-item');
  checks.push('UI backlog creation persisted in real gateway');
  await navigate(`/cc/#backlog?item=${encodeURIComponent(itemId!)}&mode=edit`);
  await visible('.detail-panel .actions button.danger');
  click('.detail-panel .actions button.danger');
  click('.detail-panel .actions button.danger');
  await waitFor(
    'backlog deletion persisted',
    () =>
      !rpc('backlog.list', { project }).items.some((item: { id: string }) => item.id === itemId),
  );
  itemId = undefined;
  checks.push('UI backlog deletion persisted in real gateway');

  await navigate(`/cc/#slot/${encodeURIComponent(slot)}`);
  await visible('[title="Search (Cmd+B)"]');
  if (!evaluate(`return find('.sv-search-input')?.getClientRects().length;`))
    click('[title="Search (Cmd+B)"]');
  await visible('.sv-search-input');
  fill('.sv-search-input', sourceFile);
  await visible('.sv-search-match');
  click('.sv-search-match');
  await visible('.monaco-editor');
  assert(
    evaluate(`return find('code-viewer')?.content?.length > 0;`),
    'Gateway file content must reach Monaco',
  );
  screenshot('source-editor');
  checks.push('real slot source opens in Monaco');

  const { targetInfos } = await protocol('Target.getTargets');
  assert(
    targetInfos.some(
      (target: { type: string; parentId: string }) =>
        target.type === 'worker' && target.parentId === pages[0].id,
    ),
    'Monaco must start its bundled worker',
  );
  assert(
    evaluate(
      `return performance.getEntriesByType('resource').some(entry => /\\/(json|editor)\\.worker-[^/]+\\.js$/.test(entry.name) && entry.transferSize > 0);`,
    ),
    'Bundled worker resource must load',
  );
  checks.push('bundled Monaco worker starts');

  await waitFor('real PTY attachment', () =>
    evaluate(`return find('terminal-view')?._mode === 'pty' && find('terminal-view')?._connected;`),
  );
  const initialColumns = evaluate(`return find('terminal-view')._terminal.cols;`);
  await protocol(
    'Emulation.setDeviceMetricsOverride',
    { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false },
    async () => {
      await waitFor('terminal fits resized viewport', () =>
        evaluate(`return find('terminal-view')._terminal.cols !== ${initialColumns};`),
      );
      screenshot('terminal-resized');
    },
  );
  await waitFor('terminal restores viewport', () =>
    evaluate(`return find('terminal-view')._terminal.cols === ${initialColumns};`),
  );
  checks.push('terminal resizes with desktop viewport');
  const receiptDirectory = await mkdtemp(path.join(tmpdir(), 'electron-terminal-'));
  const receipt = path.join(receiptDirectory, 'receipt');
  const marker = `electron-terminal-${Date.now()}`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    click('.terminal-container');
    await protocol('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      modifiers: 2,
    });
    await protocol('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      modifiers: 2,
    });
    await delay(150);
    await protocol('Input.insertText', {
      text: `printf '%s' ${quote(marker)} > ${quote(receipt)}`,
    });
    await delay(150);
    await protocol('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    await protocol('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await waitFor('terminal command writes its receipt', () => existsSync(receipt));
    assert.equal(await readFile(receipt, 'utf8'), marker);
    screenshot('terminal-command');
    checks.push('real terminal keystrokes execute in fixture tmux shell');
  } finally {
    await rm(receiptDirectory, { recursive: true, force: true });
  }

  fill('.sv-search-input', 'apps/companion/assets/icon-production.png');
  await visible('.sv-search-match');
  click('.sv-search-match');
  await waitFor('authenticated gateway image loads', () =>
    evaluate(
      `const image=find('.sv-image-viewer img');return image?.complete && image.naturalWidth > 0 && new URL(image.src).port === ${JSON.stringify(new URL(gatewayUrl).port)};`,
    ),
  );
  screenshot('gateway-image');
  checks.push('authenticated gateway HTTP image renders');

  await navigate('/cc/#dev/stream-feed');
  await visible('#feed-small');
  const streamToggle = 'dev-harness > p.section-label + div > button';
  click(streamToggle);
  await waitFor('synthetic H.264 frames decode', () =>
    evaluate(`return find('#feed-small')?._frameCount > 5 && find('#feed-hd')?._frameCount > 5;`),
  );
  screenshot('h264-renderer');
  click(streamToggle);
  checks.push('synthetic H.264 WebCodecs rendering compatibility');

  await navigate('/cc/#fleet');
  await connected();
  checks.push('saved credential reconnects after full page navigation');
  result.passed = true;
  result.limitations = [
    'Actual device stream transport and macOS sleep/resume still require a live device and manual OS validation.',
  ];
} finally {
  // Clean up only this invocation's item if an assertion interrupted the UI flow.
  if (itemId) rpc('backlog.delete', { itemId });
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ ...result, evidence }));
