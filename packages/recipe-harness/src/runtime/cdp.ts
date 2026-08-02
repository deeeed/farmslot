import path from 'node:path';

import WebSocket from 'ws';

import type { UiObserverRef } from '@farmslot/protocol';

import {
  type GestureAction,
  gestureDurationMs,
  gesturePhase,
  gesturePoints,
  gestureSegmentDuration,
  gestureTarget,
  type UiPoint,
} from '../adapters/gesture.js';
import type { StandardUiAction, UiActionTransport, UiTransportResult } from '../adapters/ui.js';
import { asNumber, asOptionalString, asString, isRecord } from '../core/json.js';
import { writeFileWithinRoot } from '../core/path.js';
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

export interface JsonGetOptions {
  timeoutMs?: number;
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

interface CdpCallOptions {
  timeoutMs?: number;
}

class CdpCallTimeoutError extends Error {}

export async function jsonGet<T = unknown>(url: string, options: JsonGetOptions = {}): Promise<T> {
  const controller = options.timeoutMs === undefined ? undefined : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  try {
    const response = await fetch(url, { signal: controller?.signal });
    if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
    return (await response.json()) as T;
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error(`GET ${url} timed out after ${options.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
      return await jsonGet<T>(url, {
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      // Expected while a browser/debug target is still starting; retry until the caller's deadline.
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
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

  static async connect(
    webSocketDebuggerUrl: string,
    options: { timeoutMs?: number } = {},
  ): Promise<CdpSession> {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timeoutMs = options.timeoutMs;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
        if (timer) clearTimeout(timer);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          ws.once('error', () => undefined);
          ws.terminate();
          reject(new Error(`CDP connection timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }
    });
    return new CdpSession(ws);
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpCallOptions = {},
  ): Promise<T> {
    const id = ++this.#nextId;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve(value) {
          if (timeout) clearTimeout(timeout);
          resolve(value as T);
        },
        reject(error) {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
    });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.reject(
          new CdpCallTimeoutError(`CDP ${method} timed out after ${options.timeoutMs}ms.`),
        );
      }, options.timeoutMs);
    }
    try {
      this.#ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.#pending.delete(id);
      if (timeout) clearTimeout(timeout);
      throw error;
    }
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

export interface CdpCompositorProbe {
  status: 'ready' | 'suspended' | 'not-interactive';
  frameAdvanced: boolean;
  interactiveTargetFound: boolean;
  hitTestOk: boolean | null;
  reason?: string;
}

interface CdpCallSession {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpCallOptions,
  ): Promise<T>;
}

const COMPOSITOR_WORLD = 'farmslot-compositor-probe';
const DOM_SETTLEMENT_WORLD = 'farmslot-dom-settlement';
class CdpPageEvaluationError extends Error {}
const isolatedWorldContexts = new WeakMap<
  CdpCallSession,
  Map<string, { executionContextId: number }>
>();

async function evaluateCdpSessionInIsolatedWorld<T>(
  session: CdpCallSession,
  expression: string,
  worldName: string,
  timeoutMs?: number,
): Promise<T> {
  let contexts = isolatedWorldContexts.get(session);
  if (!contexts) {
    contexts = new Map();
    isolatedWorldContexts.set(session, contexts);
  }
  let isolatedWorld = contexts.get(worldName);
  if (!isolatedWorld) {
    const frameTree = await session.call<{
      frameTree?: { frame?: { id?: string } };
    }>('Page.getFrameTree', {}, { timeoutMs });
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) throw new Error('CDP evaluation could not resolve the page frame.');
    const created = await session.call<{ executionContextId?: number }>(
      'Page.createIsolatedWorld',
      { frameId, worldName },
      { timeoutMs },
    );
    if (created.executionContextId === undefined) {
      throw new Error('CDP evaluation could not create an isolated world.');
    }
    isolatedWorld = { executionContextId: created.executionContextId };
    contexts.set(worldName, isolatedWorld);
  }
  try {
    const result = await session.call<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      {
        expression,
        contextId: isolatedWorld.executionContextId,
        awaitPromise: true,
        returnByValue: true,
      },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      throw new CdpPageEvaluationError(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'CDP isolated-world evaluation failed.',
      );
    }
    return result.result?.value as T;
  } catch (error) {
    // Navigation destroys the cached execution context. Evicting it is safe
    // because the retry resolves the current main frame and creates a new world.
    if (isTransientCdpContextError(error)) contexts.delete(worldName);
    throw error;
  }
}

async function retryTransientCdpContext<T>(
  deadline: number,
  attempt: (remainingMs: number) => Promise<T>,
  minimumRetryBudgetMs = 0,
): Promise<T> {
  let lastError: unknown;
  do {
    try {
      return await attempt(Math.max(1, deadline - Date.now()));
    } catch (error) {
      // A document commit temporarily invalidates its frame or execution
      // context. Retrying is correct while the caller's total budget remains.
      if (!isTransientCdpContextError(error)) throw error;
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= minimumRetryBudgetMs) break;
      await sleep(Math.min(25, remainingMs));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

/**
 * Distinguish a reachable JavaScript context from a renderable, interactive
 * browser page. Hardened pages are retried in an isolated world so page policy
 * cannot hide requestAnimationFrame from the readiness probe. Navigation races
 * return a suspended report rather than rejecting the probe.
 */
export async function probeCdpCompositorInteractivity(
  session: CdpCallSession,
  timeoutMs = 1_000,
): Promise<CdpCompositorProbe> {
  const frameTimeoutReason = `Compositor frame did not advance within ${timeoutMs}ms`;
  // Reserve a small outer-timer margin so the retry loop can surface its final
  // transient error instead of racing a timeout scheduled for the same instant.
  const retryGraceMs = Math.min(50, Math.max(1, Math.floor(timeoutMs / 5)));
  const deadline = Date.now() + Math.max(1, timeoutMs - retryGraceMs);
  type EvaluationResult = {
    result?: { value?: Omit<CdpCompositorProbe, 'status'> };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  const expression = `(async () => {
    const startedAt = performance.now();
    const frameAdvanced = await new Promise((resolve) => {
      requestAnimationFrame((firstFrame) => {
        requestAnimationFrame((secondFrame) => resolve(secondFrame > firstFrame));
      });
    });
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"]')];
    const visibleTargets = candidates.filter((element) => {
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight;
    });
    let hitTestOk = null;
    if (visibleTargets.length > 0) {
      hitTestOk = visibleTargets.some((target) => {
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return Boolean(hit && (hit === target || target.contains(hit)));
      });
    }
    return {
      frameAdvanced: frameAdvanced && performance.now() > startedAt,
      interactiveTargetFound: visibleTargets.length > 0,
      hitTestOk,
    };
  })()`;
  const evaluate = (remainingMs: number) =>
    session.call<EvaluationResult>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      { timeoutMs: remainingMs },
    );
  try {
    const result = await withTimeout(
      (async () => {
        const pageResult = await retryTransientCdpContext(deadline, evaluate);
        const description =
          pageResult.exceptionDetails?.exception?.description ??
          pageResult.exceptionDetails?.text ??
          '';
        if (
          !description.includes('requestAnimationFrame') ||
          !description.includes('inaccessible under scuttling mode')
        ) {
          return pageResult;
        }
        return retryTransientCdpContext(
          deadline,
          async (remainingMs): Promise<EvaluationResult> => {
            const value = await evaluateCdpSessionInIsolatedWorld<
              Omit<CdpCompositorProbe, 'status'>
            >(session, expression, COMPOSITOR_WORLD, remainingMs);
            return { result: { value } };
          },
        );
      })(),
      timeoutMs,
      frameTimeoutReason,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'CDP compositor probe evaluation failed.',
      );
    }
    const value = result.result?.value;
    if (!value?.frameAdvanced) {
      return {
        status: 'suspended',
        frameAdvanced: false,
        interactiveTargetFound: Boolean(value?.interactiveTargetFound),
        hitTestOk: value?.hitTestOk ?? null,
        reason: 'The compositor frame did not advance.',
      };
    }
    if (value.interactiveTargetFound && value.hitTestOk !== true) {
      return {
        status: 'not-interactive',
        frameAdvanced: true,
        interactiveTargetFound: true,
        hitTestOk: false,
        reason: 'The visible interactive target failed browser hit testing.',
      };
    }
    return {
      status: 'ready',
      frameAdvanced: true,
      interactiveTargetFound: Boolean(value.interactiveTargetFound),
      hitTestOk: value.hitTestOk ?? null,
    };
  } catch (error) {
    if (
      (error instanceof Error && error.message === frameTimeoutReason) ||
      error instanceof CdpCallTimeoutError ||
      isTransientCdpContextError(error)
    ) {
      return {
        status: 'suspended',
        frameAdvanced: false,
        interactiveTargetFound: false,
        hitTestOk: null,
        reason:
          error instanceof Error && error.message === frameTimeoutReason
            ? frameTimeoutReason
            : `Compositor probe could not evaluate: ${String(
                error instanceof Error ? error.message : error,
              )}`,
      };
    }
    throw error;
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
    const currentUrl = await this.currentNavigationUrl();
    const expectedUrl = new URL(url, currentUrl).href;
    let notifyLoaded: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      notifyLoaded = resolve;
    });
    const unsubscribe = this.session.on('Page.loadEventFired', () => notifyLoaded?.());
    try {
      const result = await this.session.call<{ errorText?: string; loaderId?: string }>(
        'Page.navigate',
        { url: expectedUrl },
      );
      const wasIntercepted = result.errorText === 'net::ERR_ABORTED';
      if (result.errorText && !wasIntercepted) {
        throw new Error(`CDP navigation failed: ${result.errorText}`);
      }
      // Extension external-link interception aborts the requested load before routing the tab.
      if (wasIntercepted) {
        await this.waitForNavigationUrlChange(currentUrl, deadline);
      }
      if (result.loaderId && !wasIntercepted) {
        await withTimeout(
          loaded,
          Math.max(1, deadline - Date.now()),
          `CDP navigation timed out after ${timeoutMs}ms`,
        );
      }
      await this.waitForDocumentReady({
        expectedUrl: result.loaderId || wasIntercepted ? undefined : expectedUrl,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      return result;
    } finally {
      unsubscribe();
    }
  }

  private async currentNavigationUrl(): Promise<string> {
    const history = await this.session.call<{
      currentIndex: number;
      entries: Array<{ url: string }>;
    }>('Page.getNavigationHistory');
    const currentUrl = history.entries[history.currentIndex]?.url;
    if (!currentUrl) throw new Error('CDP could not resolve the current page URL.');
    return currentUrl;
  }

  private async waitForNavigationUrlChange(originalUrl: string, deadline: number): Promise<void> {
    while (Date.now() <= deadline) {
      if ((await this.currentNavigationUrl()) !== originalUrl) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(50, remainingMs));
    }
    if ((await this.currentNavigationUrl()) !== originalUrl) return;
    throw new Error('CDP navigation failed: net::ERR_ABORTED');
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
    const quietMs = Math.min(300, Math.max(1, Math.floor(timeoutMs / 2)));
    const deadline = Date.now() + timeoutMs;
    const timeoutReason = `CDP document did not settle within ${timeoutMs}ms`;
    const supersededReason = 'CDP DOM settlement was superseded by another probe.';
    try {
      await retryTransientCdpContext(
        deadline,
        async (attemptTimeoutMs) => {
          const expression = `new Promise((resolve, reject) => { const key = '__farmslotDomSettlementCancel'; globalThis[key]?.(); const quietMs = ${quietMs}; const observedRoots = new Set(); let quietTimer; let rootPoll; let timeout; let observer; let finished = false; const cleanup = () => { observer?.disconnect(); clearTimeout(quietTimer); clearTimeout(timeout); clearInterval(rootPoll); if (globalThis[key] === cancel) delete globalThis[key]; }; const cancel = () => { if (finished) return; finished = true; cleanup(); resolve(false); }; globalThis[key] = cancel; const finish = () => { if (finished) return; const animations = typeof document.getAnimations === 'function' ? document.getAnimations({ subtree: true }) : []; const finiteAnimations = animations.filter((animation) => animation.effect?.getTiming().iterations !== Infinity); if (finiteAnimations.some((animation) => animation.playState === 'running' || animation.playState === 'pending')) { schedule(); return; } finished = true; cleanup(); resolve(true); }; const schedule = () => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); }; const observeRoot = (root) => { if (!observedRoots.has(root)) { observedRoots.add(root); observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); schedule(); } for (const element of root.querySelectorAll('*')) { if (element.shadowRoot) observeRoot(element.shadowRoot); } }; const discoverRoots = () => observeRoot(document); observer = new MutationObserver(() => { discoverRoots(); schedule(); }); discoverRoots(); rootPoll = setInterval(discoverRoots, Math.min(25, quietMs)); requestAnimationFrame(() => requestAnimationFrame(schedule)); timeout = setTimeout(() => { if (finished) return; finished = true; cleanup(); reject(new Error('DOM remained active for this settlement attempt.')); }, ${attemptTimeoutMs}); })`;
          const settled = await withTimeout(
            evaluateCdpSessionInIsolatedWorld<boolean>(
              this.session,
              expression,
              DOM_SETTLEMENT_WORLD,
              attemptTimeoutMs + 25,
            ),
            attemptTimeoutMs + 50,
            timeoutReason,
          );
          if (!settled) throw new Error(supersededReason);
        },
        quietMs,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === timeoutReason || error.message === supersededReason)
      ) {
        throw error;
      }
      throw new Error(
        `${timeoutReason}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  async evaluateInIsolatedWorld<T = unknown>(expression: string, worldName: string): Promise<T> {
    try {
      return await evaluateCdpSessionInIsolatedWorld<T>(this.session, expression, worldName);
    } catch (error) {
      if (!isTransientCdpContextError(error)) throw error;
      return evaluateCdpSessionInIsolatedWorld<T>(this.session, expression, worldName);
    }
  }

  async click(selector: string): Promise<unknown> {
    const target = await this.evaluate<{
      x: number;
      y: number;
      selector: string;
      tagName: string;
    }>(
      `(() => { ${deepQueryHelpersExpression()} const el = querySelectorDeep(${JSON.stringify(selector)}); if (!el) throw new Error('Selector not found: ${escapeForJsMessage(selector)}'); el.scrollIntoView({ block: 'center', inline: 'center' }); const point = clickablePointDeep(el); return { ...point, selector: ${JSON.stringify(selector)}, tagName: el.tagName }; })()`,
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
      `(() => { ${deepQueryHelpersExpression()} const expected = ${JSON.stringify(text)}; const candidates = querySelectorAllDeep('button, [role=button], a, label, input, textarea, [tabindex]'); const el = candidates.find((candidate) => (candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('value') || '').trim().includes(expected)); if (!el) throw new Error('Text target not found: ${escapeForJsMessage(text)}'); el.scrollIntoView({ block: 'center', inline: 'center' }); const point = clickablePointDeep(el); return { ...point, text: expected, tagName: el.tagName }; })()`,
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

  async resolveGesturePoint(target: string | UiPoint): Promise<UiPoint> {
    if (typeof target !== 'string') return target;
    const selector = dataTestId(target);
    return this.evaluate<UiPoint>(
      `(() => { ${deepQueryHelpersExpression()} const el = querySelectorDeep(${JSON.stringify(selector)}); if (!el) throw new Error('Gesture target not found: ${escapeForJsMessage(target)}'); el.scrollIntoView({ block: 'center', inline: 'center' }); return clickablePointDeep(el); })()`,
    );
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
      `(() => { const root = document.scrollingElement || document.documentElement; root.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}); return { scrolled: true }; })()`,
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
    await writeFileWithinRoot(
      context.artifactsDir,
      relativePath,
      Buffer.from(result.data, 'base64'),
    );
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
            `(() => { const hashPath = location.hash.split('?')[0]; const hashRoute = hashPath && !hashPath.includes('=') ? hashPath : undefined; return { provider: 'cdp-web', name: document.title || location.pathname || hashRoute || 'Browser', title: document.title || undefined, route: hashRoute || location.pathname || undefined, url: location.origin + location.pathname }; })()`,
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

function isTransientCdpContextError(error: unknown): boolean {
  if (error instanceof CdpPageEvaluationError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|execution context with given id not found|cannot find context with specified id|execution context is not available in detached frame|inspected target navigated or closed|not attached to an active page|session with given id not found|no frame (?:with|for) given id found|frame with the given id (?:is|was) not found/iu.test(
    message,
  );
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
            return executeSettledCdpAction(
              page,
              page.navigate(
                url,
                node.timeout_ms == null
                  ? undefined
                  : asNumber(node.timeout_ms, 'ui.navigate.timeout_ms'),
              ),
              node,
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
                asInputText(node.value ?? node.text, 'ui.set_input.value'),
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
          case 'ui.swipe':
          case 'ui.pan':
          case 'ui.drag':
          case 'ui.long_press':
            return executeSettledCdpAction(page, executeCdpGesture(page, action, node), node);
          case 'ui.wait_for':
            return executeSettledCdpAction(
              page,
              page.waitFor({
                selector: asOptionalString(selectorForUiInput(node), 'ui.wait_for.selector'),
                text: asOptionalString(node.text, 'ui.wait_for.text'),
                expected: asOptionalString(node.expected, 'ui.wait_for.expected'),
                timeoutMs:
                  node.timeout_ms == null
                    ? undefined
                    : asNumber(node.timeout_ms, 'ui.wait_for.timeout_ms'),
              }),
              node,
            );
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
        }
      });
    },
    async observe(refs, node, context) {
      const input = { action: 'app.status' as StandardUiAction, node, context };
      return withCdpWebPage(options, input, async (page) => page.observe(refs));
    },
  };
}

async function executeCdpGesture(
  page: CdpWebPage,
  action: GestureAction,
  node: Record<string, unknown>,
): Promise<UiTransportResult> {
  const start = await page.resolveGesturePoint(gestureTarget(node, action));
  const durationMs = gestureDurationMs(node, action);
  const points = gesturePoints(action, node, start);
  const segmentDurationMs = gestureSegmentDuration(durationMs, points);
  const pointer =
    (await page.evaluate<number>('navigator.maxTouchPoints || 0')) > 0 ? 'touch' : 'mouse';
  const phases = [];
  const startedAtMs = Date.now();

  if (pointer === 'touch') {
    await page.session.call('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, radiusX: 1, radiusY: 1 }],
    });
  } else {
    await page.session.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...start,
      button: 'none',
    });
    await page.session.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...start,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
  }
  phases.push(gesturePhase('start', start, startedAtMs));

  for (const point of points.slice(1)) {
    await sleep(segmentDurationMs);
    if (pointer === 'touch') {
      await page.session.call('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...point, radiusX: 1, radiusY: 1 }],
      });
    } else {
      await page.session.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...point,
        button: 'left',
        buttons: 1,
      });
    }
    phases.push(gesturePhase('move', point, startedAtMs));
  }

  const end = points.at(-1)!;
  if (pointer === 'touch') {
    await page.session.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.session.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...end,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }
  phases.push(gesturePhase('end', end, startedAtMs));
  return {
    kind: 'ui-transport-result',
    output: { action, pointer, resolvedStart: start, resolvedEnd: end },
    phases,
  };
}

function asInputText(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value, label);
}

async function executeSettledCdpAction<T>(
  page: CdpWebPage,
  operation: Promise<T>,
  node: Record<string, unknown>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await operation;
  if (node.settle === false) return result;
  // timeout_ms budgets the whole node: settlement only gets what the action left over.
  const timeoutMs =
    node.timeout_ms == null
      ? undefined
      : Math.max(1, asNumber(node.timeout_ms, 'ui action timeout_ms') - (Date.now() - startedAt));
  try {
    await page.waitForDomSettled(timeoutMs);
    return result;
  } catch (error) {
    const settlementWarning = error instanceof Error ? error.message : String(error);
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return { ...result, settlementWarning };
    }
    return { result, settlementWarning } as T;
  }
}

function visibleTargetsExpression(): string {
  return `(() => {
    const visibleLimit = 20;
    const hiddenLimit = 10;
    const selector = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]'
    ].join(',');
    ${deepQueryHelpersExpression()}
    const nodes = querySelectorAllDeep(selector);
    const textFor = (el) => {
      const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || '';
      return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 120) || undefined;
    };
    const cssString = (value) => '"' + Array.from(String(value), (character) => {
      const code = character.codePointAt(0);
      if (character === '"' || character === '\\\\') return '\\\\' + character;
      if (code === 0) return '\\uFFFD';
      if (code <= 0x1f || code === 0x7f) return '\\\\' + code.toString(16) + ' ';
      return character;
    }).join('') + '"';
    const cssPath = (el) => {
      if (el.id) return '[id=' + cssString(el.id) + ']';
      const testAttribute = ['data-testid', 'data-test-id', 'data-test'].find((attribute) => el.hasAttribute(attribute));
      if (testAttribute) {
        return '[' + testAttribute + '=' + cssString(el.getAttribute(testAttribute)) + ']';
      }
      if (shadowHostFor(el.getRootNode())) return undefined;
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1) {
        if (current.id) {
          parts.unshift('[id=' + cssString(current.id) + ']');
          break;
        }
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : tag);
        current = parent;
      }
      return parts.join(' > ');
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
    const composedContains = (ancestor, descendant) => {
      let current = descendant;
      while (current) {
        if (current === ancestor) return true;
        const root = current.getRootNode();
        current = current.parentElement || shadowHostFor(root);
      }
      return false;
    };
    const isCoveredDeep = (el, rect) => {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const deeper = hit.shadowRoot.elementFromPoint(x, y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      if (!hit) return false;
      return !composedContains(el, hit);
    };
    const items = [];
    const hidden_or_offscreen = [];
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      const hasBox = rect.width > 0 && rect.height > 0;
      const rendered = hasBox && isRenderedDeep(el);
      const visible = rendered && isVisibleDeep(el);
      const covered = visible && isCoveredDeep(el, rect);
      if (visible && !covered && items.length < visibleLimit) {
        items.push(itemFor(el, rect, true));
      } else if ((!visible || covered) && hidden_or_offscreen.length < hiddenLimit) {
        hidden_or_offscreen.push({ ...itemFor(el, rendered ? rect : undefined, rendered), reason: covered ? 'covered' : rendered ? 'offscreen' : 'hidden_or_no_box' });
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
    kind: 'ui-transport-result',
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
      const payload = ${JSON.stringify({ title, status, nodeId, phase, flow, action, text, detail, error, current, total, layout, position, showTitle, showDebug, showDetail, width, maxDetailLines })};
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
  return `(() => { const el = querySelectorDeep(${JSON.stringify(selector)}); return Boolean(el && isVisibleDeep(el)); })()`;
}

function deepQueryHelpersExpression(): string {
  return `
    const shadowHostFor = (root) =>
      root && root.nodeType === 11 && root.host ? root.host : null;
    const querySelectorAllDeep = (selector, root = document) => {
      const matches = Array.from(root.querySelectorAll(selector));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) matches.push(...querySelectorAllDeep(selector, element.shadowRoot));
      }
      return matches;
    };
    const querySelectorDeep = (selector, root = document) => querySelectorAllDeep(selector, root)[0] ?? null;
    const isRenderedDeep = (element) => {
      if (!element || element.getClientRects().length === 0) return false;
      let current = element;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0) return false;
        const root = current.getRootNode();
        current = current.parentElement || shadowHostFor(root);
      }
      return true;
    };
    const isVisibleDeep = (element) => {
      if (!isRenderedDeep(element)) return false;
      let rect = element.getBoundingClientRect();
      let current = element;
      while (current) {
        const root = current.getRootNode();
        const parent = current.parentElement || shadowHostFor(root);
        if (!parent) break;
        const style = getComputedStyle(parent);
        if (/(hidden|clip|scroll|auto)/.test(style.overflow + style.overflowX + style.overflowY)) {
          const parentRect = parent.getBoundingClientRect();
          rect = { left: Math.max(rect.left, parentRect.left), top: Math.max(rect.top, parentRect.top), right: Math.min(rect.right, parentRect.right), bottom: Math.min(rect.bottom, parentRect.bottom) };
          if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
        }
        current = parent;
      }
      return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };
    const clickablePointDeep = (element) => {
      if (!isVisibleDeep(element)) throw new Error('Target is not visible');
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('Target is disabled');
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const deeper = hit.shadowRoot.elementFromPoint(x, y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      const composedContains = (ancestor, descendant) => {
        let current = descendant;
        while (current) {
          if (current === ancestor) return true;
          const root = current.getRootNode();
          current = current.parentElement || shadowHostFor(root);
        }
        return false;
      };
      if (!hit || !composedContains(element, hit)) throw new Error('Target is obscured');
      return { x, y };
    };
    const renderedTextDeep = (root = document) => {
      const chunks = [];
      const walker = document.createTreeWalker(root, 4);
      let node = walker.nextNode();
      while (node) {
        if (node.parentElement && isRenderedDeep(node.parentElement)) chunks.push(node.nodeValue || '');
        node = walker.nextNode();
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot && isRenderedDeep(element)) {
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
