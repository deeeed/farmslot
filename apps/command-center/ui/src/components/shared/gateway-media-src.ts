import { noChange, nothing } from 'lit';
import { AsyncDirective } from 'lit/async-directive.js';
import { directive } from 'lit/directive.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { readGatewayAuth } from '../../gateway-url.js';
import { gatewayHttpFetch, gatewayHttpOrigin } from '../../utils/gateway-origin.js';

function hasGatewayMediaAuth(): boolean {
  const { token, password } = readGatewayAuth();
  return Boolean(token || password);
}

export function requiresGatewayMediaHeaders(url: string): boolean {
  if (!hasGatewayMediaAuth()) return false;
  const origin = gatewayHttpOrigin();
  // Authored Markdown can contain placeholder ports or otherwise invalid links.
  if (!URL.canParse(url, origin)) return false;
  const parsed = new URL(url, origin);
  return parsed.origin === origin && parsed.pathname.startsWith('/api/');
}

/** The owner releases the object URL when its view closes or changes source. */
export async function loadGatewayMedia(
  url: string,
  signal: AbortSignal,
): Promise<{ url: string; dispose(): void }> {
  if (!requiresGatewayMediaHeaders(url)) return { url, dispose() {} };
  const resource = new URL(url, gatewayHttpOrigin());
  resource.searchParams.delete('token');
  resource.searchParams.delete('password');
  const response = await gatewayHttpFetch(resource.toString(), { signal });
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

type GatewayMediaFormat = 'url' | 'html';

export class GatewayMedia extends AsyncDirective {
  private source: string | undefined;
  private lastUrl: string | undefined;
  private lastFormat: GatewayMediaFormat = 'url';
  private abort: AbortController | undefined;
  private media: Awaited<ReturnType<typeof loadGatewayMedia>> | undefined;
  private initial: ReturnType<typeof unsafeHTML> | typeof nothing = nothing;

  render(url: string, format: GatewayMediaFormat = 'url') {
    this.lastUrl = url;
    this.lastFormat = format;
    if (!(format === 'html' ? hasGatewayMediaAuth() : requiresGatewayMediaHeaders(url))) {
      this.release();
      this.source = undefined;
      return this.value(url, format);
    }
    const source = `${format}:${url}`;
    if (this.source === source) return noChange;
    this.release();
    this.source = source;
    const abort = new AbortController();
    this.abort = abort;
    const loading =
      format === 'html' ? this.loadDocument(url) : loadGatewayMedia(url, abort.signal);
    loading
      .then((media) => {
        if (abort.signal.aborted) {
          media.dispose();
          return;
        }
        this.media = media;
        this.setValue(this.value(media.url, format));
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.source = undefined;
        this.setValue(this.initial);
        // Fetch failures remain visible and never fall back to a credential-bearing URL.
        console.error('Gateway media could not be loaded.', error);
      });
    return this.initial;
  }

  protected disconnected(): void {
    this.release();
    this.source = undefined;
  }

  protected reconnected(): void {
    if (this.lastUrl) this.setValue(this.render(this.lastUrl, this.lastFormat));
  }

  private value(content: string, format: GatewayMediaFormat) {
    return format === 'html' ? unsafeHTML(content) : content;
  }

  private async loadDocument(html: string) {
    const document = new GatewayMediaDocument();
    const media = { url: '', dispose: () => document.dispose() };
    // Own partially loaded blobs before awaiting the rest of the document.
    this.media = media;
    const loaded = document.html(html);
    if (document.initialHtml) this.initial = unsafeHTML(document.initialHtml);
    media.url = await loaded;
    return media;
  }

  private release(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.media?.dispose();
    this.media = undefined;
    this.initial = nothing;
  }
}

export const gatewayMediaSrc = directive(GatewayMedia);
export const gatewayMediaHtml = (html: string) => gatewayMediaSrc(html, 'html');

/** Sanitized report HTML keeps its inline media on the same header-only path. */
export class GatewayMediaDocument {
  private readonly abort = new AbortController();
  private readonly resources = new Map<string, Awaited<ReturnType<typeof loadGatewayMedia>>>();
  initialHtml = '';

  async html(html: string): Promise<string> {
    if (!hasGatewayMediaAuth()) return html;
    const document = new DOMParser().parseFromString(html, 'text/html');
    const serialize = () =>
      /^\s*(?:<!doctype|<html)/i.test(html)
        ? document.documentElement.outerHTML
        : document.body.innerHTML;
    const targets: Array<{ node: Element; attribute: string; url: string }> = [];
    for (const node of document.querySelectorAll('img[src],video[src],source[src],a[href]')) {
      const attribute = node.hasAttribute('src') ? 'src' : 'href';
      const url = node.getAttribute(attribute);
      if (!url || !requiresGatewayMediaHeaders(url)) continue;
      targets.push({ node, attribute, url });
      node.removeAttribute(attribute);
    }
    // Keep review text readable immediately, without issuing unauthenticated media requests.
    this.initialHtml = serialize();
    for (const { node, attribute, url } of targets) {
      let resource = this.resources.get(url);
      if (!resource) {
        try {
          resource = await loadGatewayMedia(url, this.abort.signal);
        } catch (error) {
          if (this.abort.signal.aborted) throw error;
          // A missing attachment must not hide the review or restore an uncredentialed URL.
          node.setAttribute('title', error instanceof Error ? error.message : 'Media unavailable');
          if (node.tagName === 'IMG') {
            node.setAttribute('alt', `${node.getAttribute('alt') || 'Image'} (unavailable)`);
          } else {
            const label = node.tagName === 'SOURCE' ? node.parentElement : node;
            label?.insertAdjacentText('afterend', ' (Media unavailable)');
          }
          continue;
        }
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
    return serialize();
  }

  dispose(): void {
    this.abort.abort();
    for (const resource of this.resources.values()) resource.dispose();
    this.resources.clear();
  }
}
