import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import WebSocket from 'ws';

import type { UiObserverRef } from '@farmslot/protocol';

import type { StandardUiAction, UiActionTransport, UiTransportResult } from '../adapters/ui.js';
import { asNumber, asOptionalString, asString, isRecord } from '../core/json.js';
import type { ActionExecutionContext, RecipeObservationResult } from '../core/types.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dataTestId(testId: string): string {
  return `[data-testid="${escapeCssAttrValue(testId)}"]`;
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  description?: string;
}

export interface RetryJsonGetOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface SelectCdpTargetOptions {
  host?: string;
  port: number;
  type?: string;
  urlIncludes?: string;
  titleIncludes?: string;
  predicate?: (target: CdpTargetInfo) => boolean;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export async function jsonGet<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

export async function retryJsonGet<T = unknown>(
  url: string,
  options: RetryJsonGetOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      return await jsonGet<T>(url);
    } catch (error) {
      // Expected while a browser/debug target is still starting; retry until the caller's deadline.
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`GET ${url} did not succeed within ${timeoutMs}ms: ${message}`);
}

export async function listCdpTargets(host: string, port: number): Promise<CdpTargetInfo[]> {
  return retryJsonGet<CdpTargetInfo[]>(`http://${host}:${port}/json`);
}

export async function selectCdpTarget(options: SelectCdpTargetOptions): Promise<CdpTargetInfo> {
  const host = options.host ?? '127.0.0.1';
  const targets = await listCdpTargets(host, options.port);
  const selected = targets.find((target) => {
    if (options.type && target.type !== options.type) return false;
    if (options.urlIncludes && !target.url?.includes(options.urlIncludes)) return false;
    if (options.titleIncludes && !target.title?.includes(options.titleIncludes)) return false;
    if (options.predicate && !options.predicate(target)) return false;
    return true;
  });
  if (!selected) {
    throw new Error(
      `No CDP target matched ${JSON.stringify({
        host,
        port: options.port,
        type: options.type,
        urlIncludes: options.urlIncludes,
        titleIncludes: options.titleIncludes,
      })}.`,
    );
  }
  return selected;
}

export type CdpEventHandler = (params: Record<string, unknown>) => void;

export class CdpSession {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, PendingCall>();
  readonly #eventHandlers = new Map<string, Set<CdpEventHandler>>();
  #nextId = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (buffer) => this.#handleMessage(buffer.toString()));
    ws.on('error', (error) => this.#rejectAll(error));
    ws.on('close', () => this.#rejectAll(new Error('CDP websocket closed.')));
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CdpSession(ws);
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#nextId;
    const response = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve(value) {
          resolve(value as T);
        },
        reject,
      });
    });
    this.#ws.send(JSON.stringify({ id, method, params }));
    return response;
  }

  on(method: string, handler: CdpEventHandler): () => void {
    const handlers = this.#eventHandlers.get(method) ?? new Set<CdpEventHandler>();
    handlers.add(handler);
    this.#eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  close(): void {
    this.#ws.close();
  }

  #handleMessage(text: string): void {
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.method && message.id == null) {
      const handlers = this.#eventHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) handler(message.params ?? {});
      }
      return;
    }
    if (message.id == null) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'CDP call failed.'));
      return;
    }
    pending.resolve(message.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export class CdpWebPage {
  readonly session: CdpSession;

  constructor(session: CdpSession) {
    this.session = session;
  }

  static async connectToTarget(target: CdpTargetInfo): Promise<CdpWebPage> {
    if (!target.webSocketDebuggerUrl)
      throw new Error(`CDP target ${target.id} has no websocket URL.`);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await session.call('Runtime.enable');
    await session.call('Page.enable');
    return new CdpWebPage(session);
  }

  async navigate(url: string, timeoutMs = 10_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    const expectedUrl = await this.evaluate<string>(
      `new URL(${JSON.stringify(url)}, location.href).href`,
    );
    let notifyLoaded: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      notifyLoaded = resolve;
    });
    const unsubscribe = this.session.on('Page.loadEventFired', () => notifyLoaded?.());
    try {
      const result = await this.session.call<{ errorText?: string; loaderId?: string }>(
        'Page.navigate',
        { url },
      );
      if (result.errorText) throw new Error(`CDP navigation failed: ${result.errorText}`);
      if (result.loaderId) {
        await withTimeout(
          loaded,
          Math.max(1, deadline - Date.now()),
          `CDP navigation timed out after ${timeoutMs}ms`,
        );
      }
      await this.waitForDocumentReady({
        expectedUrl: result.loaderId ? undefined : expectedUrl,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      await this.waitForDomSettled(Math.max(1, deadline - Date.now()));
      return result;
    } finally {
      unsubscribe();
    }
  }

  async waitForDocumentReady(options: { expectedUrl?: string; timeoutMs?: number }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const state = await this.evaluate<{ ready: boolean; url: string }>(
          `(() => ({ ready: document.readyState === 'interactive' || document.readyState === 'complete', url: location.href }))()`,
        );
        if (state.ready && (!options.expectedUrl || state.url === options.expectedUrl)) return;
      } catch (error) {
        // Runtime contexts can disappear briefly while a document navigation commits.
        lastError = error;
      }
      await sleep(50);
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`CDP document was not ready within ${timeoutMs}ms${detail}`);
  }

  async waitForDomSettled(timeoutMs = 10_000): Promise<void> {
    const quietMs = Math.min(100, Math.max(1, Math.floor(timeoutMs / 2)));
    await withTimeout(
      this.evaluate(
        `new Promise((resolve, reject) => { const quietMs = ${quietMs}; const observedRoots = new Set(); let quietTimer; let rootPoll; let timeout; let finished = false; const cleanup = () => { observer.disconnect(); clearTimeout(quietTimer); clearTimeout(timeout); clearInterval(rootPoll); }; const finish = () => { if (finished) return; finished = true; cleanup(); resolve(true); }; const schedule = () => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); }; const observeRoot = (root) => { if (!observedRoots.has(root)) { observedRoots.add(root); observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); schedule(); } for (const element of root.querySelectorAll('*')) { if (element.shadowRoot) observeRoot(element.shadowRoot); } }; const discoverRoots = () => observeRoot(document); const observer = new MutationObserver(() => { discoverRoots(); schedule(); }); discoverRoots(); rootPoll = setInterval(discoverRoots, Math.min(25, quietMs)); requestAnimationFrame(() => requestAnimationFrame(schedule)); timeout = setTimeout(() => { if (finished) return; finished = true; cleanup(); reject(new Error('DOM remained active for ${timeoutMs}ms')); }, ${timeoutMs}); })`,
      ),
      timeoutMs + 50,
      `CDP document did not settle within ${timeoutMs}ms`,
    );
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.session.call<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'CDP evaluation failed.',
      );
    }
    return result.result?.value as T;
  }

  async click(selector: string): Promise<unknown> {
    const target = await this.evaluate<{
      x: number;
      y: number;
      selector: string;
      tagName: string;
    }>(
      `(() => { ${deepQueryHelpersExpression()} const el = querySelectorDeep(${JSON.stringify(selector)}); if (!el) throw new Error('Selector not found: ${escapeForJsMessage(selector)}'); el.scrollIntoView({ block: 'center', inline: 'center' }); const rect = el.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) throw new Error('Selector has no clickable box: ${escapeForJsMessage(selector)}'); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, selector: ${JSON.stringify(selector)}, tagName: el.tagName }; })()`,
    );
    await this.clickPoint(target.x, target.y);
    return { clicked: true, selector: target.selector, tagName: target.tagName };
  }

  async clickText(text: string): Promise<unknown> {
    const target = await this.evaluate<{
      x: number;
      y: number;
      text: string;
      tagName: string;
    }>(
      `(() => { ${deepQueryHelpersExpression()} const expected = ${JSON.stringify(text)}; const candidates = querySelectorAllDeep('button, [role=button], a, label, input, textarea, [tabindex]'); const el = candidates.find((candidate) => (candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('value') || '').trim().includes(expected)); if (!el) throw new Error('Text target not found: ${escapeForJsMessage(text)}'); el.scrollIntoView({ block: 'center', inline: 'center' }); const rect = el.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) throw new Error('Text target has no clickable box: ${escapeForJsMessage(text)}'); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: expected, tagName: el.tagName }; })()`,
    );
    await this.clickPoint(target.x, target.y);
    return { clicked: true, text: target.text, tagName: target.tagName };
  }

  async setInput(selector: string, value: string): Promise<unknown> {
    const before = await this.evaluate<{
      selector: string;
      tagName: string;
      previousValue: string;
    }>(
      `(() => { ${deepQueryHelpersExpression()} const root = querySelectorDeep(${JSON.stringify(selector)}); if (!root) throw new Error('Selector not found: ${escapeForJsMessage(selector)}'); const el = root.matches('input, textarea, [contenteditable="true"], [contenteditable=""]') ? root : querySelectorDeep('input, textarea, [contenteditable="true"], [contenteditable=""]', root); if (!el) throw new Error('Input target not found inside selector: ${escapeForJsMessage(selector)}'); if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Input target is disabled: ${escapeForJsMessage(selector)}'); el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus(); if (typeof el.select === 'function') { el.select(); } else { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); } return { selector: ${JSON.stringify(selector)}, tagName: el.tagName, previousValue: el.value ?? el.textContent ?? '' }; })()`,
    );
    await this.session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace' });
    await this.session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace' });
    if (value) await this.session.call('Input.insertText', { text: value });
    const after = await this.evaluate<{ value: string }>(
      `(() => { ${deepQueryHelpersExpression()} const root = querySelectorDeep(${JSON.stringify(selector)}); const el = root && (root.matches('input, textarea, [contenteditable="true"], [contenteditable=""]') ? root : querySelectorDeep('input, textarea, [contenteditable="true"], [contenteditable=""]', root)); if (!el) throw new Error('Input target disappeared after typing: ${escapeForJsMessage(selector)}'); el.dispatchEvent(new Event('change', { bubbles: true })); return { value: el.value ?? el.textContent ?? '' }; })()`,
    );
    if (after.value !== value) {
      throw new Error(
        `Input target value mismatch after typing ${selector}: expected ${JSON.stringify(value)}, got ${JSON.stringify(after.value)}.`,
      );
    }
    return {
      set: true,
      selector: before.selector,
      tagName: before.tagName,
      previousValue: before.previousValue,
    };
  }

  async keyPress(key: string): Promise<unknown> {
    await this.session.call('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await this.session.call('Input.dispatchKeyEvent', { type: 'keyUp', key });
    return { key };
  }

  async clickPoint(x: number, y: number): Promise<void> {
    await this.session.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    });
    await this.session.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.session.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async scroll(options: {
    selector?: string;
    deltaX?: number;
    deltaY?: number;
    intoView?: boolean;
  }): Promise<unknown> {
    const deltaX = options.deltaX ?? 0;
    const deltaY = options.deltaY ?? 600;
    if (options.selector) {
      if (options.intoView) {
        return this.evaluate(
          `(() => { ${deepQueryHelpersExpression()} const el = querySelectorDeep(${JSON.stringify(options.selector)}); if (!el) throw new Error('Selector not found: ${escapeForJsMessage(options.selector)}'); el.scrollIntoView({ block: 'center', inline: 'nearest' }); return { scrolled: true, selector: ${JSON.stringify(options.selector)}, intoView: true }; })()`,
        );
      }
      return this.evaluate(
        `(() => { ${deepQueryHelpersExpression()} const el = querySelectorDeep(${JSON.stringify(options.selector)}); if (!el) throw new Error('Selector not found: ${escapeForJsMessage(options.selector)}'); el.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}); return { scrolled: true }; })()`,
      );
    }
    return this.evaluate(
      `(() => { window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}); return { scrolled: true }; })()`,
    );
  }

  async waitFor(options: {
    selector?: string;
    text?: string;
    expected?: string;
    timeoutMs?: number;
  }): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    return this.evaluate(
      `(async () => { ${deepQueryHelpersExpression()} const deadline = Date.now() + ${JSON.stringify(timeoutMs)}; while (Date.now() <= deadline) { const ok = ${waitForPredicateExpression(options)}; if (ok) return { matched: true }; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('ui.wait_for timed out'); })()`,
    );
  }

  async waitForSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.waitFor({ selector, timeoutMs: options.timeoutMs });
  }

  async waitForExpression(
    expression: string,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    return this.evaluate(
      `(async () => { const deadline = Date.now() + ${JSON.stringify(timeoutMs)}; while (Date.now() <= deadline) { if (await (${expression})) return { matched: true }; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('waitForExpression timed out'); })()`,
    );
  }

  async screenshot(
    context?: ActionExecutionContext,
    relPath?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<
    | string
    | {
        path: string;
        type: string;
        nodeId: string;
        label?: string;
        category?: string;
        mimeType: string;
      }
  > {
    const timeoutMs = typeof metadata.timeoutMs === 'number' ? metadata.timeoutMs : 30_000;
    const result = await withTimeout(
      this.session.call<{ data?: string }>('Page.captureScreenshot', {
        format: 'png',
      }),
      timeoutMs,
      `Page.captureScreenshot timed out after ${timeoutMs}ms`,
    );
    if (!result.data) throw new Error('CDP screenshot did not return data.');
    if (!context) return result.data;
    const relativePath = relPath ?? `screenshots/${context.nodeId}.png`;
    const outputPath = context.resolveArtifactPath(relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(result.data, 'base64'));
    return {
      path: relativePath,
      type: 'screenshot',
      nodeId: context.nodeId,
      label: typeof metadata.label === 'string' ? metadata.label : undefined,
      category: typeof metadata.category === 'string' ? metadata.category : 'evidence',
      mimeType: 'image/png',
    };
  }

  async observe(refs: readonly UiObserverRef[]): Promise<RecipeObservationResult> {
    const observations: Record<string, unknown> = {};
    const warnings: RecipeObservationResult['warnings'] = [];
    for (const ref of refs) {
      try {
        if (ref === 'ui.screen') {
          observations[ref] = await this.evaluate(
            `(() => ({ provider: 'cdp-web', name: document.title || location.pathname || location.hash || 'Browser', title: document.title || undefined, route: location.hash || location.pathname || undefined, url: location.href }))()`,
          );
        } else if (ref === 'ui.visible') {
          observations[ref] = await this.evaluate(visibleTargetsExpression());
        } else {
          warnings.push({ ref, message: `Unsupported UI observer: ${ref}.` });
        }
      } catch (error) {
        warnings.push({
          ref,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ...(Object.keys(observations).length ? { observations } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  close(): void {
    this.session.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export interface CdpWebUiTransportInput {
  action: StandardUiAction;
  node: Record<string, unknown>;
  context: ActionExecutionContext;
}

export interface CreateCdpWebUiTransportOptions {
  getPage?(input: CdpWebUiTransportInput): Promise<CdpWebPage>;
  withPage?<T>(
    input: CdpWebUiTransportInput,
    callback: (page: CdpWebPage) => Promise<T>,
  ): Promise<T>;
}

export function createCdpWebUiTransport(
  options: CreateCdpWebUiTransportOptions,
): UiActionTransport {
  return {
    async execute(action, node, context) {
      const input = { action, node, context };
      return withCdpWebPage(options, input, async (page) => {
        switch (action) {
          case 'ui.navigate': {
            const url = asString(node.url ?? node.target, 'ui.navigate.url');
            return page.navigate(
              url,
              node.timeout_ms == null
                ? undefined
                : asNumber(node.timeout_ms, 'ui.navigate.timeout_ms'),
            );
          }
          case 'ui.press': {
            const selector = selectorForUiInput(node);
            return executeSettledCdpAction(
              page,
              selector
                ? page.click(selector)
                : page.clickText(asString(node.text ?? node.label, 'ui.press.text')),
              node,
            );
          }
          case 'ui.key_press':
            return executeSettledCdpAction(
              page,
              page.keyPress(asString(node.key, 'ui.key_press.key')),
              node,
            );
          case 'ui.set_input':
            return executeSettledCdpAction(
              page,
              page.setInput(
                asString(selectorForUiInput(node), 'ui.set_input.selector'),
                asString(node.value ?? node.text, 'ui.set_input.value'),
              ),
              node,
            );
          case 'ui.scroll':
            return executeSettledCdpAction(
              page,
              page.scroll({
                selector: asOptionalString(selectorForUiInput(node), 'ui.scroll.selector'),
                intoView: node.scroll_into_view === true || node.into_view === true,
                deltaX:
                  node.delta_x == null ? undefined : asNumber(node.delta_x, 'ui.scroll.delta_x'),
                deltaY:
                  node.delta_y == null ? undefined : asNumber(node.delta_y, 'ui.scroll.delta_y'),
              }),
              node,
            );
          case 'ui.wait_for':
            return page.waitFor({
              selector: asOptionalString(selectorForUiInput(node), 'ui.wait_for.selector'),
              text: asOptionalString(node.text, 'ui.wait_for.text'),
              expected: asOptionalString(node.expected, 'ui.wait_for.expected'),
              timeoutMs:
                node.timeout_ms == null
                  ? undefined
                  : asNumber(node.timeout_ms, 'ui.wait_for.timeout_ms'),
            });
          case 'ui.screenshot':
            return captureCdpScreenshot(page, node, context);
          case 'app.status':
            return page.evaluate('(() => ({ url: location.href, title: document.title }))()');
          case 'app.lifecycle':
            return runCdpLifecycle(page, node);
          case 'app.hud':
            return renderCdpHud(page, node, context);
          case 'app.trace':
            return page.evaluate(
              '(() => ({ entries: performance.getEntries().slice(-20).map((entry) => ({ name: entry.name, type: entry.entryType, startTime: entry.startTime, duration: entry.duration })) }))()',
            );
          case 'ui.gesture':
            throw new Error('ui.gesture is not implemented by the CDP web transport yet.');
        }
      });
    },
    async observe(refs, node, context) {
      const input = { action: 'app.status' as StandardUiAction, node, context };
      return withCdpWebPage(options, input, async (page) => page.observe(refs));
    },
  };
}

async function executeSettledCdpAction<T>(
  page: CdpWebPage,
  operation: Promise<T>,
  node: Record<string, unknown>,
): Promise<T> {
  const result = await operation;
  await page.waitForDomSettled(
    node.timeout_ms == null ? undefined : asNumber(node.timeout_ms, 'ui action timeout_ms'),
  );
  return result;
}

function visibleTargetsExpression(): string {
  return `(() => {
    const visibleLimit = 20;
    const hiddenLimit = 10;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const selector = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[data-testid]',
      '[data-test-id]',
      '[data-test]'
    ].join(',');
    ${deepQueryHelpersExpression()}
    const nodes = querySelectorAllDeep(selector);
    const textFor = (el) => {
      const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || '';
      return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 120) || undefined;
    };
    const cssPath = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const testAttribute = ['data-testid', 'data-test-id', 'data-test'].find((attribute) => el.hasAttribute(attribute));
      if (testAttribute) {
        const testId = CSS.escape(String(el.getAttribute(testAttribute)));
        return '[' + testAttribute + '="' + testId + '"]';
      }
      if (el.getRootNode() instanceof ShadowRoot) return undefined;
      const tag = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (!parent) return tag;
      const index = Array.from(parent.children).filter((child) => child.tagName === el.tagName).indexOf(el) + 1;
      return tag + ':nth-of-type(' + index + ')';
    };
    const itemFor = (el, rect, includeLabel) => ({
      role: el.getAttribute('role') || (el.tagName.toLowerCase() === 'a' ? 'link' : el.tagName.toLowerCase() === 'button' ? 'button' : undefined),
      label: includeLabel ? textFor(el) : undefined,
      test_id: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || undefined,
      selector: cssPath(el),
      enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      selected: el.getAttribute('aria-selected') === 'true' || undefined,
      focused: document.activeElement === el || undefined,
      bounds: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined
    });
    const items = [];
    const hidden_or_offscreen = [];
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      const hasBox = rect.width > 0 && rect.height > 0;
      const onScreen = hasBox && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
      const style = getComputedStyle(el);
      const rendered = hasBox && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
      const visible = onScreen && rendered;
      if (visible && items.length < visibleLimit) {
        items.push(itemFor(el, rect, true));
      } else if (!visible && hidden_or_offscreen.length < hiddenLimit) {
        hidden_or_offscreen.push({ ...itemFor(el, rendered ? rect : undefined, rendered), reason: rendered ? 'offscreen' : 'hidden_or_no_box' });
      }
    }
    return {
      provider: 'cdp-web',
      items,
      hidden_or_offscreen,
      truncated: nodes.length > items.length + hidden_or_offscreen.length,
      limits: { items: visibleLimit, hidden_or_offscreen: hiddenLimit }
    };
  })()`;
}

async function withCdpWebPage<T>(
  options: CreateCdpWebUiTransportOptions,
  input: CdpWebUiTransportInput,
  callback: (page: CdpWebPage) => Promise<T>,
): Promise<T> {
  if (options.withPage) return options.withPage(input, callback);
  if (!options.getPage) throw new Error('CDP web UI transport requires getPage or withPage.');
  const page = await options.getPage(input);
  try {
    return await callback(page);
  } finally {
    page.close();
  }
}

export function selectorForUiInput(node: Record<string, unknown>): string | undefined {
  const selector = asOptionalString(node.selector, 'ui.selector');
  if (selector) return selector;
  const testId = asOptionalString(node.test_id ?? node.testID, 'ui.test_id');
  if (testId) {
    const escaped = escapeCssAttrValue(testId);
    return `[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-test="${escaped}"]`;
  }
  return undefined;
}

async function captureCdpScreenshot(
  page: CdpWebPage,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<UiTransportResult> {
  const artifactPath = asOptionalString(node.path, 'ui.screenshot.path') ?? `${context.nodeId}.png`;
  const normalizedPath = artifactPath.split(path.sep).join('/');
  const label = asOptionalString(node.label, 'ui.screenshot.label') ?? 'UI screenshot';
  const captured = await page.screenshot(context, normalizedPath, {
    label,
    category: asOptionalString(node.category, 'ui.screenshot.category') ?? 'evidence',
    timeoutMs:
      node.timeout_ms == null ? undefined : asNumber(node.timeout_ms, 'ui.screenshot.timeout_ms'),
  });
  const artifact =
    typeof captured === 'object' && captured !== null
      ? captured
      : {
          path: normalizedPath,
          type: 'screenshot',
          nodeId: context.nodeId,
          mimeType: 'image/png',
          label,
        };
  context.registerArtifact(artifact);
  return {
    output: { captured: true, path: normalizedPath, artifact },
    control: { artifacts: [artifact] },
  };
}

async function runCdpLifecycle(page: CdpWebPage, node: Record<string, unknown>): Promise<unknown> {
  const command = asString(node.command ?? node.event, 'app.lifecycle.command');
  if (command === 'reload') {
    return page.evaluate('(() => { location.reload(); return { command: "reload" }; })()');
  }
  if (command === 'back') {
    return page.evaluate('(() => { history.back(); return { command: "back" }; })()');
  }
  throw new Error(`Unsupported CDP lifecycle command: ${command}.`);
}

async function renderCdpHud(
  page: CdpWebPage,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<unknown> {
  if (node.clear === true) {
    return page.evaluate(
      "(() => { document.getElementById('farmslot-recipe-hud')?.remove(); document.getElementById('farmslot-recipe-hud-reserved-space')?.remove(); document.documentElement.style.removeProperty('--farmslot-recipe-hud-height'); document.body?.style.removeProperty('padding-bottom'); return { hud: false, cleared: true }; })()",
    );
  }
  const title = asOptionalString(node.title, 'app.hud.title') ?? 'Recipe run';
  const status = asOptionalString(node.status, 'app.hud.status') ?? 'running';
  const nodeId = asOptionalString(node.node_id ?? node.nodeId, 'app.hud.node_id') ?? context.nodeId;
  const phase = asOptionalString(node.phase, 'app.hud.phase') ?? '';
  const flow = asOptionalString(node.flow, 'app.hud.flow') ?? '';
  const action =
    asOptionalString(node.action_name ?? node.recipe_action, 'app.hud.action_name') ?? '';
  const proofTarget =
    asOptionalString(node.proofTarget ?? node.proof_target, 'app.hud.proofTarget') ?? '';
  const record = asOptionalString(node.record, 'app.hud.record') ?? '';
  const text = asOptionalString(node.intent ?? node.text, 'app.hud.text') ?? context.nodeId;
  const rawDetail = asOptionalString(node.detail, 'app.hud.detail') ?? '';
  const detail = rawDetail && rawDetail !== text && rawDetail !== flow ? rawDetail : '';
  const error = asOptionalString(node.error, 'app.hud.error');
  const display = isRecord(node.display) ? node.display : {};
  const layout = asOptionalString(display.layout, 'app.hud.display.layout') ?? 'bottom-bar';
  const position = asOptionalString(display.position, 'app.hud.display.position') ?? 'bottom';
  const showTitle = display.showTitle === true;
  const showDebug = display.showDebug === true;
  const showDetail = display.showDetail === true;
  const width = asOptionalString(display.width, 'app.hud.display.width') ?? '360px';
  const maxDetailLines = typeof display.maxDetailLines === 'number' ? display.maxDetailLines : 2;
  const progress = isRecord(node.progress) ? node.progress : {};
  const current = typeof progress.current === 'number' ? progress.current : undefined;
  const total = typeof progress.total === 'number' ? progress.total : undefined;
  return page.evaluate(
    `(() => {
      const payload = ${JSON.stringify({ title, status, nodeId, phase, flow, action, proofTarget, record, text, detail, error, current, total, layout, position, showTitle, showDebug, showDetail, width, maxDetailLines })};
      const id = 'farmslot-recipe-hud';
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        Object.assign(el.style, {
          position: 'fixed',
          zIndex: '2147483647',
          left: '8px',
          right: '8px',
          bottom: '8px',
          minHeight: '30px',
          padding: '5px 8px',
          borderRadius: '8px',
          background: 'rgba(8, 10, 14, 0.66)',
          color: 'white',
          font: '10px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          pointerEvents: 'none',
          boxShadow: '0 6px 22px rgba(0,0,0,0.30)',
          border: '1px solid rgba(255,255,255,0.14)',
          backdropFilter: 'blur(4px)',
        });
        document.body.appendChild(el);
      }
      const isCard = payload.layout === 'card';
      const isDocked = payload.layout === 'docked-bottom';
      Object.assign(el.style, {
        left: '',
        right: '',
        top: '',
        bottom: '',
        width: '',
        maxWidth: '',
        borderRadius: isDocked ? '0' : '9px',
      });
      if (isCard) {
        el.style.width = payload.width || '360px';
        el.style.maxWidth = 'calc(100vw - 16px)';
        if (payload.position.includes('top')) el.style.top = '8px';
        else el.style.bottom = '8px';
        if (payload.position.includes('left')) el.style.left = '8px';
        else el.style.right = '8px';
      } else {
        if (payload.position === 'top') el.style.top = '8px';
        else el.style.bottom = isDocked ? '0' : '8px';
        el.style.left = isDocked ? '0' : '8px';
        el.style.right = isDocked ? '0' : '8px';
      }
      const accent = payload.status === 'fail' ? '#ff5c5c' : payload.status === 'pass' ? '#48d17a' : '#8ab4ff';
      const progressText = Number.isFinite(payload.current) && Number.isFinite(payload.total)
        ? payload.current + '/' + payload.total
        : '';
      el.innerHTML = '';
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '7px', alignItems: 'flex-start' });
      const badge = document.createElement('div');
      Object.assign(badge.style, {
        color: accent,
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: '7px',
        padding: '1px 5px',
        fontWeight: '800',
        textTransform: 'uppercase',
        fontSize: '9px',
        lineHeight: '14px',
        whiteSpace: 'nowrap',
      });
      badge.textContent = [payload.status === 'fail' ? 'FAIL' : payload.status === 'pass' ? 'OK' : 'RUN', progressText].filter(Boolean).join(' ');
      const body = document.createElement('div');
      Object.assign(body.style, { minWidth: '0', flex: '1' });
      const line1 = document.createElement('div');
      Object.assign(line1.style, { color: '#fff', fontWeight: '750', lineHeight: '1.25', whiteSpace: 'normal' });
      line1.textContent = payload.text || payload.nodeId;
      const line2 = document.createElement('div');
      Object.assign(line2.style, {
        color: '#d6d9df',
        lineHeight: '1.25',
        whiteSpace: 'normal',
      });
      const secondaryParts = [];
      if (payload.showDetail && payload.detail) secondaryParts.push(payload.detail);
      const secondary = secondaryParts.filter((part, index) => part && secondaryParts.indexOf(part) === index).join(' · ');
      line2.textContent = payload.error ? 'error: ' + payload.error : secondary;
      const line3 = document.createElement('div');
      Object.assign(line3.style, { color: '#8f98a8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '9px', whiteSpace: 'normal' });
      line3.textContent = [payload.nodeId, payload.action].filter(Boolean).join(' · ');
      if (payload.showTitle) {
        const title = document.createElement('div');
        Object.assign(title.style, { color: '#d6d9df', fontWeight: '700', marginBottom: '2px', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        title.textContent = payload.title;
        body.append(title);
      }
      body.append(line1);
      if (line2.textContent) body.append(line2);
      if (payload.showDebug) body.append(line3);
      row.append(badge, body);
      el.append(row);
      if (payload.error) {
        line2.style.color = '#ffb3b3';
      }
      let reserve = document.getElementById('farmslot-recipe-hud-reserved-space');
      if (isDocked) {
        if (!reserve) {
          reserve = document.createElement('div');
          reserve.id = 'farmslot-recipe-hud-reserved-space';
          reserve.setAttribute('aria-hidden', 'true');
          document.body.appendChild(reserve);
        }
        const height = Math.ceil(el.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--farmslot-recipe-hud-height', height + 'px');
        Object.assign(reserve.style, {
          display: 'block',
          height: 'var(--farmslot-recipe-hud-height)',
          minHeight: 'var(--farmslot-recipe-hud-height)',
          pointerEvents: 'none',
        });
        if (document.body) {
          document.body.style.paddingBottom = 'var(--farmslot-recipe-hud-height)';
        }
      } else if (reserve) {
        reserve.remove();
        document.documentElement.style.removeProperty('--farmslot-recipe-hud-height');
        document.body?.style.removeProperty('padding-bottom');
      }
      return { hud: true, status: payload.status, nodeId: payload.nodeId, flow: payload.flow };
    })()`,
  );
}

function waitForPredicateExpression(options: {
  selector?: string;
  text?: string;
  expected?: string;
}): string {
  let presentExpression: string;
  let visibleExpression: string | undefined;
  if (options.selector && options.text) {
    const selector = JSON.stringify(options.selector);
    const text = JSON.stringify(options.text);
    presentExpression = `Boolean(querySelectorDeep(${selector})) && textIncludesDeep(${text})`;
    visibleExpression = `${visibleSelectorExpression(options.selector)} && textIncludesDeep(${text})`;
  } else if (options.selector) {
    presentExpression = `Boolean(querySelectorDeep(${JSON.stringify(options.selector)}))`;
    visibleExpression = visibleSelectorExpression(options.selector);
  } else if (options.text) {
    presentExpression = `textIncludesDeep(${JSON.stringify(options.text)})`;
  } else {
    throw new Error('ui.wait_for requires selector or text.');
  }
  const expected = String(options.expected ?? 'present').toLowerCase();
  if (expected === 'absent' || expected === 'not_present') {
    return `!(${presentExpression})`;
  }
  if (expected === 'hidden') {
    return `!(${visibleExpression ?? presentExpression})`;
  }
  if (expected === 'visible') {
    return visibleExpression ?? presentExpression;
  }
  if (expected !== 'present') {
    throw new Error(`ui.wait_for expected must be present or absent, got ${expected}.`);
  }
  return presentExpression;
}

function visibleSelectorExpression(selector: string): string {
  return `(() => { const el = querySelectorDeep(${JSON.stringify(selector)}); if (!el) return false; const rect = el.getBoundingClientRect(); const style = window.getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; })()`;
}

function deepQueryHelpersExpression(): string {
  return `
    const querySelectorAllDeep = (selector, root = document) => {
      const matches = Array.from(root.querySelectorAll(selector));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) matches.push(...querySelectorAllDeep(selector, element.shadowRoot));
      }
      return matches;
    };
    const querySelectorDeep = (selector, root = document) => querySelectorAllDeep(selector, root)[0] ?? null;
    const renderedTextDeep = (root = document) => {
      const chunks = [];
      if (root instanceof Document) {
        if (root.body) chunks.push(root.body.innerText);
      } else {
        for (const element of root.children) {
          if (element.getClientRects().length > 0) chunks.push(element.innerText);
        }
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot && element.getClientRects().length > 0) {
          chunks.push(renderedTextDeep(element.shadowRoot));
        }
      }
      return chunks.join('\\n');
    };
    const textIncludesDeep = (text) => renderedTextDeep().includes(text);
  `;
}

function escapeForJsMessage(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function escapeCssAttrValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
