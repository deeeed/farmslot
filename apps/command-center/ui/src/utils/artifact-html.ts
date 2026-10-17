import DOMPurify from 'dompurify';

import {
  ARTIFACT_HTML_CSP,
  decodeArtifactLink,
  isExternalWebLink,
} from '@farmslot/review-dispatch';

export interface HtmlArtifactTarget {
  mediaUrl: string;
  viewUrl?: string;
}

export function isolatedArtifactHtml(
  source: string,
  resolveArtifact?: (path: string) => HtmlArtifactTarget | null,
): string {
  const document = new DOMParser().parseFromString(source, 'text/html');
  const styles = [...document.querySelectorAll('style')].map((style) => style.outerHTML).join('');
  const content = DOMPurify.sanitize(styles + document.body.innerHTML, {
    FORCE_BODY: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'],
    FORBID_ATTR: ['srcdoc', 'action', 'formaction'],
    // Preserve ordinary attribute values and relative fragments; extend the
    // sanitizer's safe URI shape only for explicit Farmslot navigation links.
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|farmslot|farmslot-dev):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
  const isolated = new DOMParser().parseFromString(content, 'text/html');
  const mediaSources = new Set<string>();
  isolated.querySelectorAll('audio,source,track').forEach((node) => node.remove());
  const resolve = (file: string) => {
    const path = decodeArtifactLink(file);
    return path === null ? null : resolveArtifact?.(path);
  };
  for (const video of isolated.querySelectorAll('video')) {
    const original = video.getAttribute('src') ?? '';
    const [file, fragment] = original.split('#');
    const resolved = resolve(file);
    video.removeAttribute('src');
    video.removeAttribute('autoplay');
    video.querySelectorAll('source,track').forEach((node) => node.remove());
    if (!resolved || !/\.(mp4|webm|mov)$/i.test(file)) continue;
    const url = new URL(resolved.mediaUrl, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    mediaSources.add(url.origin);
    if (fragment && /^t=\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?)?$/.test(fragment)) url.hash = fragment;
    video.setAttribute('src', url.toString());
    video.setAttribute('controls', '');
    video.setAttribute('preload', 'metadata');
  }
  for (const anchor of isolated.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')!;
    anchor.removeAttribute('target');
    anchor.setAttribute('rel', 'noopener noreferrer');
    if (href.startsWith('#')) continue;
    const resolved = resolve(href.split('#')[0]);
    if (!resolved?.viewUrl) {
      // Source PR/docs links deliberately remain user-initiated web links.
      // Never preserve named/opener targets, authored application schemes or
      // unresolved relative links, which have no retained target.
      if (isExternalWebLink(href)) anchor.setAttribute('target', '_blank');
      else anchor.removeAttribute('href');
      continue;
    }
    const url = new URL(resolved.viewUrl, location.href);
    const traceIndex = anchor.getAttribute('data-trace-index');
    if (traceIndex && /^\d+$/.test(traceIndex)) {
      const [route, query] = url.hash.split('?');
      const params = new URLSearchParams(query);
      params.set('artifactTrace', traceIndex);
      params.set(
        'artifactPhase',
        anchor.getAttribute('data-trace-phase') === 'start' ? 'start' : 'end',
      );
      url.hash = `${route}?${params}`;
    }
    anchor.setAttribute('href', url.toString());
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  // A srcdoc document otherwise resolves #anchors against the embedding page.
  // Keep contents navigation inside this report, including closed <details>.
  for (const anchor of isolated.querySelectorAll('a[href^="#"]'))
    anchor.setAttribute('href', `about:srcdoc${anchor.getAttribute('href')}`);
  const csp = ARTIFACT_HTML_CSP.replace(
    'media-src data:',
    `media-src data: ${[...mediaSources].join(' ')}`,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}">${[...isolated.head.querySelectorAll('style')].map((style) => style.outerHTML).join('')}</head><body>${isolated.body.innerHTML}</body></html>`;
}
