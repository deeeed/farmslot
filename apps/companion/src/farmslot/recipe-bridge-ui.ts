import { router } from 'expo-router';

import { COMPANION_DEMO_BANNER_TEXT } from '../lib/demo-banner';

const DEFAULT_POLL_MS = 400;

export async function handleRecipeBridgeNavigate(
  payload: Record<string, unknown> | undefined,
): Promise<{ ok: true; route: string }> {
  const route = asRoute(payload?.url ?? payload?.target);
  router.push(route as never);
  return { ok: true, route };
}

export async function handleRecipeBridgeWaitFor(
  payload: Record<string, unknown> | undefined,
): Promise<{ ok: true; matched: string }> {
  const expected = asExpected(payload?.expected);
  const timeoutMs = asTimeoutMs(payload?.timeout_ms);
  const texts = collectWaitTexts(payload);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (expected === 'absent') {
      const absent = texts.every((text) => !isTextVisibleOnScreen(text));
      if (absent) return { ok: true, matched: texts.join(', ') };
    } else {
      const matched = texts.find((text) => isTextVisibleOnScreen(text));
      if (matched) return { ok: true, matched };
    }
    await sleep(DEFAULT_POLL_MS);
  }

  throw new Error(
    `waitFor timed out after ${timeoutMs}ms (expected=${expected}, texts=${texts.join(', ')})`,
  );
}

export async function handleRecipeBridgeScreenshot(
  payload: Record<string, unknown> | undefined,
): Promise<{ ok: true; path: string }> {
  const relativePath = asScreenshotPath(payload?.path);
  const metroPort = process.env.METRO_PORT ?? process.env.WATCHER_PORT ?? '8871';
  const host = process.env.FARMSLOT_RECIPE_METRO_HOST ?? '127.0.0.1';
  const response = await fetch(`http://${host}:${metroPort}/farmslot-recipe/simctl-screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: relativePath,
      artifacts_dir: asOptionalString(payload?.artifacts_dir),
      simulator: process.env.SIMULATOR ?? process.env.IOS_SIMULATOR,
    }),
  });
  const body = (await response.json()) as { ok?: boolean; error?: string; path?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `simctl screenshot failed with HTTP ${response.status}`);
  }
  return { ok: true, path: body.path ?? relativePath };
}

export function setCompanionDemoBannerMounted(mounted: boolean): void {
  globalThis.__FARMSLOT_DEMO_BANNER_MOUNTED__ = mounted;
}

export function setRecipeBridgeScreenText(text: string): void {
  globalThis.__FARMSLOT_RECIPE_SCREEN_TEXT__ = text;
}

function isTextVisibleOnScreen(text: string): boolean {
  if (text === COMPANION_DEMO_BANNER_TEXT) {
    return globalThis.__FARMSLOT_DEMO_BANNER_MOUNTED__ === true;
  }
  const screenText = globalThis.__FARMSLOT_RECIPE_SCREEN_TEXT__;
  return typeof screenText === 'string' && screenText.includes(text);
}

function collectWaitTexts(payload: Record<string, unknown> | undefined): string[] {
  const values: string[] = [];
  const text = asOptionalString(payload?.text);
  if (text) values.push(text);
  const contains = payload?.text_contains;
  if (Array.isArray(contains)) {
    for (const entry of contains) {
      if (typeof entry === 'string' && entry.trim()) values.push(entry.trim());
    }
  }
  if (values.length === 0) throw new Error('waitFor requires text or text_contains.');
  return values;
}

function asRoute(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('navigate requires url or target.');
  }
  return value.trim();
}

function asExpected(value: unknown): 'visible' | 'absent' {
  if (value === 'absent') return 'absent';
  return 'visible';
}

function asTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 30_000;
}

function asScreenshotPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('screenshot requires path.');
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

declare global {
  // eslint-disable-next-line no-var
  var __FARMSLOT_DEMO_BANNER_MOUNTED__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __FARMSLOT_RECIPE_SCREEN_TEXT__: string | undefined;
}