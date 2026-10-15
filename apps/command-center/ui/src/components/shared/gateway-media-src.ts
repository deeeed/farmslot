import { noChange, nothing } from 'lit';
import { AsyncDirective } from 'lit/async-directive.js';
import { directive } from 'lit/directive.js';

import { parsePersonSessionToken } from '@farmslot/protocol';

import { readGatewayAuth } from '../../gateway-url.js';
import { gatewayHttpFetch, gatewayHttpOrigin } from '../../utils/gateway-origin.js';

export function requiresGatewayMediaHeaders(url: string): boolean {
  const token = readGatewayAuth().token;
  if (!token || !parsePersonSessionToken(token, 'fsa')) return false;
  const parsed = new URL(url, gatewayHttpOrigin());
  return parsed.origin === gatewayHttpOrigin() && parsed.pathname.startsWith('/api/');
}

/** The owner releases the object URL when its view closes or changes source. */
export async function loadGatewayMedia(
  url: string,
  signal: AbortSignal,
): Promise<{ url: string; dispose(): void }> {
  if (!requiresGatewayMediaHeaders(url)) return { url, dispose() {} };
  const response = await gatewayHttpFetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load gateway media (${response.status}).`);
  const blob = await response.blob();
  signal.throwIfAborted();
  // Raw markup must not gain the dashboard's origin when opened as a blob.
  const safeBlob = /^(?:text\/html|application\/(?:xhtml\+xml|xml)|image\/svg\+xml)/i.test(
    blob.type,
  )
    ? new Blob([blob], { type: 'text/plain' })
    : blob;
  const objectUrl = URL.createObjectURL(safeBlob);
  return { url: objectUrl, dispose: () => URL.revokeObjectURL(objectUrl) };
}

class GatewayMediaSrc extends AsyncDirective {
  private source: string | undefined;
  private lastUrl: string | undefined;
  private abort: AbortController | undefined;
  private media: Awaited<ReturnType<typeof loadGatewayMedia>> | undefined;

  render(url: string) {
    this.lastUrl = url;
    if (!requiresGatewayMediaHeaders(url)) {
      this.release();
      this.source = undefined;
      return url;
    }
    if (this.source === url) return noChange;
    this.release();
    this.source = url;
    const abort = new AbortController();
    this.abort = abort;
    loadGatewayMedia(url, abort.signal)
      .then((media) => {
        if (abort.signal.aborted) {
          media.dispose();
          return;
        }
        this.media = media;
        this.setValue(media.url);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.setValue(nothing);
        // Fetch failures remain visible and never fall back to a credential-bearing URL.
        console.error('Gateway media could not be loaded.', error);
      });
    return nothing;
  }

  protected disconnected(): void {
    this.release();
    this.source = undefined;
  }

  protected reconnected(): void {
    if (this.lastUrl) this.setValue(this.render(this.lastUrl));
  }

  private release(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.media?.dispose();
    this.media = undefined;
  }
}

export const gatewayMediaSrc = directive(GatewayMediaSrc);

/** Sanitized report HTML keeps its inline media on the same header-only path. */
export class GatewayMediaDocument {
  private readonly abort = new AbortController();
  private readonly resources = new Map<string, Awaited<ReturnType<typeof loadGatewayMedia>>>();

  async html(html: string): Promise<string> {
    const token = readGatewayAuth().token;
    if (!token || !parsePersonSessionToken(token, 'fsa')) return html;
    const document = new DOMParser().parseFromString(html, 'text/html');
    for (const node of document.querySelectorAll('img[src],video[src],source[src],a[href]')) {
      const attribute = node.hasAttribute('src') ? 'src' : 'href';
      const url = node.getAttribute(attribute);
      if (!url || !requiresGatewayMediaHeaders(url)) continue;
      let resource = this.resources.get(url);
      if (!resource) {
        resource = await loadGatewayMedia(url, this.abort.signal);
        this.resources.set(url, resource);
      }
      node.setAttribute(attribute, resource.url);
    }
    this.abort.signal.throwIfAborted();
    if (this.resources.size) {
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const policy = csp?.getAttribute('content');
      if (csp && policy)
        csp.setAttribute(
          'content',
          policy.replace(/(?:img-src|media-src) [^;]*/g, (rule) => `${rule} blob:`),
        );
    }
    return /^\s*(?:<!doctype|<html)/i.test(html)
      ? document.documentElement.outerHTML
      : document.body.innerHTML;
  }

  dispose(): void {
    this.abort.abort();
    for (const resource of this.resources.values()) resource.dispose();
    this.resources.clear();
  }
}
