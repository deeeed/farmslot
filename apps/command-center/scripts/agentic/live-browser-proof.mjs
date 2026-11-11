import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Bounded polling for live proofs; never part of a default test suite. */
export async function until(read, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live browser proof deadline');
}

/** Own one isolated Agent Chrome page, leaving gateway traffic and credentials untouched. */
export async function openLiveBrowserProof({ transformSource }) {
  const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
  const source = process.env.FARMSLOT_PROOF_SOURCE_ORIGIN;
  const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
  const output = process.env.FARMSLOT_PROOF_OUT;
  const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
  assert(origin && source && endpoint && output && browserModule);
  assert.equal(new URL(endpoint).hostname, '127.0.0.1');
  await mkdir(output, { recursive: true });
  const { chromium } = await import(pathToFileURL(browserModule).href);
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await browser.contexts()[0].newPage();
  const errors = [],
    failedResponses = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({ url: response.url(), status: response.status() });
  });
  const proxy = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname.startsWith('/api/') || url.pathname === '/ws')
      return route.continue();
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'const styles=new Map();export const createHotContext=()=>({on(){},accept(){},prune(){},dispose(){},data:{}});export const injectQuery=(u)=>u;export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement("style");document.head.append(s);styles.set(id,s)}s.textContent=css}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id)}',
      });
    const response = await fetch(new URL(url.pathname + url.search, source));
    const body = await transformSource({ url, body: Buffer.from(await response.arrayBuffer()) });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(
          ([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key),
        ),
      ),
      body,
    });
  };
  const workerPattern = `${origin}/@fs/**`;
  const close = async () => {
    try {
      await browser.contexts()[0].unroute(workerPattern, proxy);
    } finally {
      try {
        await page.close();
      } finally {
        await browser.close();
      }
    }
  };
  try {
    await page.route(`${origin}/**`, proxy);
    await browser.contexts()[0].route(workerPattern, proxy);
    return { page, origin, output, errors, failedResponses, close };
  } catch (error) {
    await close();
    throw error;
  }
}
