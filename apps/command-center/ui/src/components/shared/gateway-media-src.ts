import { noChange, nothing } from 'lit';
import { AsyncDirective } from 'lit/async-directive.js';
import { directive, type Part, PartType } from 'lit/directive.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import {
  isRunArtifactImagePath,
  isRunEvidenceVideoArtifact,
  RUN_ARTIFACT_MEDIA_GRANT_PARAM,
  type RunArtifactMediaGrant,
} from '@farmslot/protocol';

import { readGatewayAuth } from '../../gateway-url.js';
import {
  gatewayHttpFetch,
  gatewayHttpOrigin,
  sameOriginGatewayHttpUrl,
} from '../../utils/gateway-origin.js';

const MAX_HELD_MEDIA_URLS = 2000;
const heldMediaIds = new Map<string, string>();
/**
 * Sources whose body failed its manifest `sha256`, per owner: settled until the URL, the
 * identity or the owner changes. Another principal reads the source again.
 */
const mismatchedMedia = new WeakMap<object, Set<string>>();
const NO_OWNER = {};

/**
 * Names the manifest `sha256` behind an evidence image URL, so the media seam shows only bytes
 * that verify, at any size, and keeps what it loads within the 2 MB image cap (Content rule 4).
 * Returns the URL unchanged.
 */
export function gatewayContentMediaUrl(
  url: string,
  artifact: { path: string; sha256?: string } | undefined,
): string {
  const sha256 = artifact?.sha256;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !isRunArtifactImagePath(artifact.path))
    return url;
  heldMediaIds.delete(url);
  heldMediaIds.set(url, sha256);
  if (heldMediaIds.size > MAX_HELD_MEDIA_URLS)
    heldMediaIds.delete(heldMediaIds.keys().next().value!);
  return url;
}

function objectMedia(blob: Blob): { url: string; dispose(): void } {
  // Raw markup must not gain the dashboard's origin when opened as a blob.
  const safeBlob = /^(?:text\/html|application\/(?:xhtml\+xml|xml)|image\/svg\+xml)/i.test(
    blob.type,
  )
    ? new Blob([blob], { type: 'text/plain' })
    : blob;
  const objectUrl = URL.createObjectURL(safeBlob);
  return { url: objectUrl, dispose: () => URL.revokeObjectURL(objectUrl) };
}

function hasGatewayMediaAuth(): boolean {
  const { token, password } = readGatewayAuth();
  return Boolean(token || password);
}

export function requiresGatewayMediaHeaders(url: string): boolean {
  return hasGatewayMediaAuth() && isGatewayMediaUrl(url);
}

function isGatewayMediaUrl(url: string): boolean {
  const origin = gatewayHttpOrigin();
  // Authored Markdown can contain placeholder ports or otherwise invalid links.
  if (!URL.canParse(url, origin)) return false;
  const parsed = new URL(url, origin);
  return parsed.origin === origin && parsed.pathname.startsWith('/api/');
}

/** Cached galleries can mount before a saved device session has restored its access token. */
async function waitForGatewayMediaAuth(url: string, signal: AbortSignal): Promise<void> {
  if (typeof window === 'undefined' || !isGatewayMediaUrl(url)) return;
  const { gateway } = await import('../../gateway-client.js');
  signal.throwIfAborted();
  if (gateway.connectionState === 'connected') return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      unsubscribe();
      reject(signal.reason);
    };
    const unsubscribe = gateway.onConnectionChange((state) => {
      if (state !== 'connected') return;
      unsubscribe();
      signal.removeEventListener('abort', abort);
      resolve();
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function fetchGatewayMedia(url: string, signal: AbortSignal): Promise<Blob> {
  await waitForGatewayMediaAuth(url, signal);
  const resource = new URL(url, gatewayHttpOrigin());
  resource.searchParams.delete('token');
  resource.searchParams.delete('password');
  const response = await gatewayHttpFetch(resource.toString(), { signal });
  if (!response.ok) throw new Error(`Could not load gateway media (${response.status}).`);
  const blob = await response.blob();
  signal.throwIfAborted();
  return blob;
}

/**
 * An evidence image with a manifest `sha256` (Content rules 1 and 2): held bytes first, offline
 * and online, else live bytes shown and kept only when they verify. A body that does not match
 * is never shown, and its URL is not used in its place.
 */
async function loadContentMedia(url: string, sha256: string, signal: AbortSignal) {
  // Loaded only when content can be held, so plain media keeps a light import graph.
  const held = await import('../../held-content.js');
  const owner = held.contentOwner() ?? NO_OWNER;
  const key = { kind: 'artifact' as const, id: sha256 };
  const data = await held.openHeldContent(key);
  signal.throwIfAborted();
  if (data) return objectMedia(new Blob([new Uint8Array(data)]));
  // A settled mismatch is not fetched again, so a re-render cannot loop on the same body.
  const source = `${url}\n${sha256}`;
  if (mismatchedMedia.get(owner)?.has(source))
    throw new Error('Gateway media does not match its manifest.');
  let type = '';
  const verified = await held.readVerifiedContent(
    key,
    async () => {
      const blob = await fetchGatewayMedia(url, signal);
      type = blob.type;
      return new Uint8Array(await blob.arrayBuffer());
    },
    'gate',
  );
  if (verified === held.CONTENT_MISMATCH) {
    const mismatched = mismatchedMedia.get(owner) ?? new Set<string>();
    mismatchedMedia.set(owner, mismatched);
    mismatched.add(source);
    if (mismatched.size > MAX_HELD_MEDIA_URLS) mismatched.delete(mismatched.values().next().value!);
    throw new Error('Gateway media does not match its manifest.');
  }
  signal.throwIfAborted();
  return objectMedia(new Blob([new Uint8Array(verified)], { type }));
}

/** The owner releases the object URL when its view closes or changes source. */
export async function loadGatewayMedia(
  url: string,
  signal: AbortSignal,
): Promise<{ url: string; dispose(): void }> {
  const sha256 = heldMediaIds.get(url);
  if (sha256) return loadContentMedia(url, sha256, signal);
  await waitForGatewayMediaAuth(url, signal);
  if (!requiresGatewayMediaHeaders(url)) return { url, dispose() {} };
  return objectMedia(await fetchGatewayMedia(url, signal));
}

interface LoadedGatewayMedia {
  url: string;
  dispose(): void;
  renewalUrl?: string;
}

async function loadGatewayVideo(url: string, signal: AbortSignal): Promise<LoadedGatewayMedia> {
  if (!isGatewayMediaUrl(url)) return loadGatewayMedia(url, signal);
  const resource = new URL(url, gatewayHttpOrigin());
  if (
    resource.pathname !== '/api/run-artifact' ||
    !isRunEvidenceVideoArtifact({ path: resource.searchParams.get('path') ?? '' })
  )
    return loadGatewayMedia(url, signal);
  await waitForGatewayMediaAuth(url, signal);
  resource.searchParams.delete('token');
  resource.searchParams.delete('password');
  const response = await gatewayHttpFetch(resource.toString(), { method: 'POST', signal });
  if (response.status !== 201) {
    await response.body?.cancel();
    // Older gateways serve artifact bytes on POST. Keep their existing playback path.
    if (response.status === 200) return loadGatewayMedia(url, signal);
    throw new Error(`Could not open gateway recording (${response.status}).`);
  }
  const grant = (await response.json()) as RunArtifactMediaGrant;
  signal.throwIfAborted();
  const playback = new URL(grant.url, resource);
  if (
    playback.origin !== resource.origin ||
    playback.pathname !== resource.pathname ||
    !playback.searchParams.has(RUN_ARTIFACT_MEDIA_GRANT_PARAM) ||
    playback.searchParams.has('token') ||
    playback.searchParams.has('password')
  )
    throw new Error('Gateway returned an invalid playback URL.');
  playback.hash = resource.hash;
  const urlForPlayer = sameOriginGatewayHttpUrl(playback.toString());
  playback.searchParams.delete(RUN_ARTIFACT_MEDIA_GRANT_PARAM);
  return {
    url: urlForPlayer,
    renewalUrl:
      playback.searchParams.has('bundleDigest') &&
      /^[a-f0-9]{64}$/u.test(playback.searchParams.get('v') ?? '')
        ? playback.toString()
        : undefined,
    dispose() {},
  };
}

type GatewayMediaFormat = 'url' | 'html' | 'video';

export class GatewayMedia extends AsyncDirective {
  private source: string | undefined;
  private lastUrl: string | undefined;
  private lastFormat: GatewayMediaFormat = 'url';
  private onError?: () => void;
  private abort: AbortController | undefined;
  private media: LoadedGatewayMedia | undefined;
  private video?: HTMLVideoElement;
  private initial: ReturnType<typeof unsafeHTML> | typeof nothing = nothing;

  override update(part: Part, [url, format, onError]: Parameters<GatewayMedia['render']>) {
    this.video =
      format === 'video' && part.type === PartType.ATTRIBUTE && part.element.localName === 'video'
        ? (part.element as HTMLVideoElement)
        : undefined;
    return this.render(url, format, onError);
  }

  render(url: string, format: GatewayMediaFormat = 'url', onError?: () => void) {
    this.lastUrl = url;
    this.lastFormat = format;
    this.onError = onError;
    if (
      !(format === 'html'
        ? hasGatewayMediaAuth()
        : requiresGatewayMediaHeaders(url) ||
          heldMediaIds.has(url) ||
          (typeof window !== 'undefined' && isGatewayMediaUrl(url)))
    ) {
      this.release();
      this.source = undefined;
      return this.value(url, format);
    }
    // A new manifest identity for the same URL is a new source, so a held failure is read again.
    const source = `${format}:${url}\n${heldMediaIds.get(url) ?? ''}`;
    if (this.source === source) return noChange;
    this.release();
    this.source = source;
    const abort = new AbortController();
    this.abort = abort;
    const loading: Promise<LoadedGatewayMedia> =
      format === 'html'
        ? this.loadDocument(url)
        : (format === 'video' ? loadGatewayVideo : loadGatewayMedia)(url, abort.signal);
    loading
      .then((media) => {
        if (abort.signal.aborted) {
          media.dispose();
          return;
        }
        this.media = media;
        if (media.renewalUrl && this.video)
          this.watchVideo(this.video, media.renewalUrl, abort.signal);
        this.setValue(this.value(media.url, format));
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        // A failure stays settled for this source, so a re-render of the same URL does not fetch
        // it again (a missing file would otherwise be requested on every render). It loads once
        // more for another URL, when the view mounts again, or when the gateway connection
        // comes back after a drop or restart.
        this.setValue(this.initial);
        this.onError?.();
        this.retryOnReconnect(abort.signal);
        // Fetch failures remain visible and never fall back to a credential-bearing URL.
        console.error('Gateway media could not be loaded.', error);
      });
    return this.initial;
  }

  private watchVideo(video: HTMLVideoElement, renewalUrl: string, signal: AbortSignal): void {
    let requestedTime: number | undefined;
    let canRenew = true;
    let renewing = false;
    let playing = !video.paused;
    video.addEventListener(
      'play',
      () => {
        playing = true;
      },
      { signal },
    );
    video.addEventListener(
      'pause',
      () => {
        playing = false;
      },
      { signal },
    );
    video.addEventListener(
      'seeking',
      () => {
        requestedTime = video.currentTime;
      },
      { signal },
    );
    video.addEventListener(
      'seeked',
      () => {
        requestedTime = undefined;
        if (!renewing) canRenew = true;
      },
      { signal },
    );
    video.addEventListener(
      'loadeddata',
      () => {
        if (!renewing && !video.seeking) canRenew = true;
      },
      { signal },
    );
    // Capture before the lightbox's error listener can replace the player. The browser does
    // not expose the media response status, so retry one failed signed source per decoded load.
    video.addEventListener(
      'error',
      (event) => {
        if (!renewing && (!canRenew || this.media?.renewalUrl !== renewalUrl)) return;
        event.stopImmediatePropagation();
        if (renewing) return;
        canRenew = false;
        renewing = true;
        const position = requestedTime ?? video.currentTime;
        const resume = playing;
        void loadGatewayVideo(renewalUrl, signal)
          .then((media) => {
            if (signal.aborted) {
              media.dispose();
              return;
            }
            if (media.renewalUrl !== renewalUrl) {
              media.dispose();
              throw new Error('The retained recording is unavailable.');
            }
            video.addEventListener(
              'loadedmetadata',
              () => {
                const time = requestedTime ?? position;
                video.currentTime = Number.isFinite(video.duration)
                  ? Math.min(time, video.duration)
                  : time;
                if (resume)
                  void video.play().catch((error: unknown) => {
                    // Renewing a source can lose user activation. Leave the native player paused.
                    if (!(error instanceof DOMException) || error.name !== 'NotAllowedError')
                      console.error('Could not resume gateway recording.', error);
                  });
              },
              { once: true, signal },
            );
            this.media?.dispose();
            this.media = media;
            renewing = false;
            this.setValue(media.url);
          })
          .catch((error: unknown) => {
            if (signal.aborted) return;
            renewing = false;
            console.error('Could not renew gateway recording.', error);
            video.dispatchEvent(new Event('error'));
          });
      },
      { capture: true, signal },
    );
  }

  private retryOnReconnect(signal: AbortSignal): void {
    if (typeof window === 'undefined') return;
    void import('../../gateway-client.js').then(({ gateway }) => {
      if (signal.aborted) return;
      let dropped = gateway.connectionState !== 'connected';
      const unsubscribe = gateway.onConnectionChange((state) => {
        if (state !== 'connected') {
          dropped = true;
          return;
        }
        if (!dropped) return;
        unsubscribe();
        this.source = undefined;
        if (this.lastUrl) this.setValue(this.render(this.lastUrl, this.lastFormat, this.onError));
      });
      // Another source, a remount or the view closing calls release(), which aborts the failed
      // load and so ends this watch: a closed view is never loaded again.
      signal.addEventListener('abort', unsubscribe, { once: true });
    });
  }

  protected disconnected(): void {
    this.release();
    this.source = undefined;
  }

  protected reconnected(): void {
    if (this.lastUrl) this.setValue(this.render(this.lastUrl, this.lastFormat, this.onError));
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
export const gatewayVideoSrc = (url: string, onError?: () => void) =>
  gatewayMediaSrc(url, 'video', onError);
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
