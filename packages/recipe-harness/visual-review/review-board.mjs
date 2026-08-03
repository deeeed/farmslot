import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_FILE_ID = /^[a-zA-Z0-9._-]+$/u;

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

function safeFileId(value, label) {
  const normalized = String(value);
  if (!SAFE_FILE_ID.test(normalized)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, or dashes.`);
  }
  return normalized;
}

function documentShell({ title, assetPrefix, assetVersion, body, bodyAttributes = '' }) {
  const version = encodeURIComponent(assetVersion);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${assetPrefix}assets/review-board.css?v=${escapeHtml(version)}">
</head>
<body ${bodyAttributes}>
${body}
  <script src="${assetPrefix}assets/review-board.js?v=${escapeHtml(version)}"></script>
</body>
</html>
`;
}

function sourcePlatforms(source) {
  return [
    ...new Set(
      source.surfaces.flatMap((surface) => surface.captures.map(({ platform }) => platform)),
    ),
  ];
}

function platformLabel(platform) {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'web') return 'Web';
  return platform;
}

function platformFilterHtml(source, defaultPlatform) {
  const platforms = sourcePlatforms(source).sort((left, right) => {
    if (left === defaultPlatform) return -1;
    if (right === defaultPlatform) return 1;
    return 0;
  });
  if (platforms.length < 2) return '';
  return `<div class="platform-filter" role="group" aria-label="Capture platform">
    ${platforms
      .map(
        (platform) =>
          `<button type="button" data-platform-filter="${escapeHtml(platform)}" aria-pressed="false">${escapeHtml(platformLabel(platform))}</button>`,
      )
      .join('')}
    <button type="button" data-platform-filter="all" aria-pressed="false">Compare platforms</button>
  </div>`;
}

function bodyAttributes(source, storageKey, defaultPlatform) {
  return [
    `data-feedback-key="${escapeHtml(storageKey)}"`,
    `data-source-id="${escapeHtml(source.id)}"`,
    `data-captured-at="${escapeHtml(source.capturedAt)}"`,
    `data-platforms="${escapeHtml(sourcePlatforms(source).join(','))}"`,
    `data-default-platform="${escapeHtml(defaultPlatform)}"`,
  ].join(' ');
}

function surfaceById(source) {
  return new Map(source.surfaces.map((surface) => [surface.id, surface]));
}

function surfaceAncestors(source, surface) {
  const byId = surfaceById(source);
  const ancestors = [];
  let parentId = surface.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  return ancestors;
}

function incomingNavigationEdges(source, surfaceId) {
  return (source.navigationEdges ?? []).filter((edge) => edge.toSurfaceId === surfaceId);
}

function navigationKindHtml(kind) {
  return `<span class="navigation-kind navigation-kind--${escapeHtml(kind)}">${escapeHtml(kind)}</span>`;
}

function surfaceDescendantCount(source, surfaceId) {
  const children = source.surfaces.filter((surface) => surface.parentId === surfaceId);
  return children.reduce((count, child) => count + 1 + surfaceDescendantCount(source, child.id), 0);
}

function surfaceTreeHtml(source, parentId, depth = 0) {
  const children = source.surfaces.filter((surface) => surface.parentId === parentId);
  if (children.length === 0) return '';
  return `<ul class="surface-tree${parentId ? ' surface-tree--nested' : ''}"${
    parentId
      ? ` id="surface-children-${escapeHtml(parentId)}" data-surface-children="${escapeHtml(parentId)}" hidden`
      : ''
  }>${children
    .map((surface) => {
      const incoming = incomingNavigationEdges(source, surface.id);
      const descendantCount = surfaceDescendantCount(source, surface.id);
      return `<li class="surface-node" data-surface-node="${escapeHtml(surface.id)}" data-surface-depth="${depth}">
      <div class="surface-node__row">
        ${
          descendantCount > 0
            ? `<button class="surface-toggle" type="button" data-surface-toggle="${escapeHtml(surface.id)}" data-surface-title="${escapeHtml(surface.title)}" aria-controls="surface-children-${escapeHtml(surface.id)}" aria-expanded="false"><span class="surface-toggle__icon" aria-hidden="true">›</span><span class="visually-hidden" data-toggle-label>Expand ${escapeHtml(surface.title)}</span></button>`
            : '<span class="surface-toggle-spacer" aria-hidden="true"></span>'
        }
        <a class="screen-link" data-surface-platforms="${escapeHtml(surface.captures.map(({ platform }) => platform).join(','))}" href="screens/${escapeHtml(surface.id)}.html#surface-${escapeHtml(surface.id)}">
        <div class="screen-link__meta">
          <code>${escapeHtml(surface.id)}</code>
          <span><span data-surface-capture-count>${surface.captures.length} capture${surface.captures.length === 1 ? '' : 's'}</span>${descendantCount > 0 ? ` · ${descendantCount} nested` : ''}</span>
        </div>
        <h2>${escapeHtml(surface.title)}</h2>
        ${surface.location ? `<code>${escapeHtml(surface.location)}</code>` : ''}
        ${
          incoming.length > 0
            ? `<div class="navigation-paths">${incoming
                .map(
                  (edge) =>
                    `${navigationKindHtml(edge.kind)}<span>from ${escapeHtml(surfaceById(source).get(edge.fromSurfaceId)?.title ?? edge.fromSurfaceId)}</span>`,
                )
                .join('')}</div>`
            : ''
        }
        <div class="platforms">${surface.captures
          .map(
            (capture) =>
              `<span data-platform="${escapeHtml(capture.platform)}">${escapeHtml(platformLabel(capture.platform))}</span>`,
          )
          .join('')}</div>
        </a>
      </div>
      ${surfaceTreeHtml(source, surface.id, depth + 1)}
    </li>`;
    })
    .join('')}</ul>`;
}

function indexHtml(source, storageKey, defaultPlatform, assetVersion) {
  return documentShell({
    title: source.title,
    assetPrefix: '',
    assetVersion,
    bodyAttributes: bodyAttributes(source, storageKey, defaultPlatform),
    body: `
  <header class="board-header">
    <div>
      <h1>${escapeHtml(source.title)}</h1>
      <p>${escapeHtml(source.capturedAt)}${source.description ? ` · ${escapeHtml(source.description)}` : ''}</p>
    </div>
    <div class="header-actions">${platformFilterHtml(source, defaultPlatform)}<button data-feedback-download type="button">Download feedback JSON</button></div>
  </header>
  <main class="screen-index" aria-label="Captured surfaces">
    <section class="navigation-map" aria-labelledby="navigation-map-title">
      <div class="navigation-map__heading">
        <div><h2 id="navigation-map-title">Navigation map</h2><p>Indentation shows branches; edge labels show how the destination is presented.</p></div>
        <div class="navigation-map__tools">
          <div class="tree-actions" aria-label="Navigation tree controls">
            <button type="button" data-tree-action="expand">Expand all</button>
            <button type="button" data-tree-action="collapse">Collapse all</button>
          </div>
          <div class="navigation-legend" aria-label="Navigation relationship legend">
            ${['tab', 'push', 'in-place', 'modal', 'replace']
              .map(
                (kind) => `<span class="navigation-kind navigation-kind--${kind}">${kind}</span>`,
              )
              .join('')}
          </div>
        </div>
      </div>
      ${surfaceTreeHtml(source, undefined)}
    </section>
  </main>`,
  });
}

function screenHtml(source, storageKey, defaultPlatform, surface, index, assetVersion) {
  const byId = surfaceById(source);
  const ancestors = surfaceAncestors(source, surface);
  const children = source.surfaces.filter((candidate) => candidate.parentId === surface.id);
  const hierarchicalIds = new Set([
    ...ancestors.map((candidate) => candidate.id),
    ...children.map((candidate) => candidate.id),
  ]);
  const related = (surface.relatedSurfaceIds ?? [])
    .map((id) => byId.get(id))
    .filter((candidate) => candidate && !hierarchicalIds.has(candidate.id));
  const incoming = incomingNavigationEdges(source, surface.id);
  const previous = source.surfaces[index - 1];
  const next = source.surfaces[index + 1];
  const captures = surface.captures
    .map(
      (capture) => `
      <article class="capture" data-capture-platform="${escapeHtml(capture.platform)}">
        <header class="capture__header">
          <div><span>Same screen</span><h2>${escapeHtml(surface.title)} · ${escapeHtml(platformLabel(capture.platform))}</h2></div>
          <code>${escapeHtml(capture.id)}</code>
        </header>
        <div class="capture__image">
          <div class="annotation-stage" data-annotation-surface data-surface-id="${escapeHtml(surface.id)}" data-capture-id="${escapeHtml(capture.id)}">
            <img src="../${escapeHtml(capture.image.path)}" alt="${escapeHtml(surface.title)} on ${escapeHtml(capture.platform)}" draggable="false">
            <div class="annotation-markers" aria-label="Point annotations"></div>
          </div>
        </div>
        <aside class="capture__notes">
          <div class="annotation-tools" aria-label="Annotation shape">
            <button type="button" data-annotation-mode="point" aria-pressed="true">Point</button>
            <button type="button" data-annotation-mode="area" aria-pressed="false">Area</button>
          </div>
          <p class="annotation-help" data-annotation-help>Click the screenshot to comment on a specific element.</p>
          <ol class="annotation-list" data-annotation-list data-surface-id="${escapeHtml(surface.id)}" data-capture-id="${escapeHtml(capture.id)}"></ol>
        </aside>
      </article>`,
    )
    .join('');

  return documentShell({
    title: `${surface.title} · ${source.title}`,
    assetPrefix: '../',
    assetVersion,
    bodyAttributes: bodyAttributes(source, storageKey, defaultPlatform),
    body: `
  <header class="screen-header">
    <div>
      <nav class="breadcrumbs" aria-label="Surface hierarchy">
        <a href="../index.html#review-board">All surfaces</a>
        ${ancestors
          .map(
            (ancestor) =>
              `<span>›</span><a href="${escapeHtml(ancestor.id)}.html#surface-${escapeHtml(ancestor.id)}">${escapeHtml(ancestor.title)}</a>`,
          )
          .join('')}
      </nav>
      <h1>${escapeHtml(surface.title)}</h1>
      <p>${surface.location ? `<code>${escapeHtml(surface.location)}</code> · ` : ''}${escapeHtml(surface.id)}</p>
      ${
        incoming.length > 0
          ? `<div class="navigation-context">${incoming
              .map(
                (edge) =>
                  `${navigationKindHtml(edge.kind)}<span>from <a href="${escapeHtml(edge.fromSurfaceId)}.html#surface-${escapeHtml(edge.fromSurfaceId)}">${escapeHtml(byId.get(edge.fromSurfaceId)?.title ?? edge.fromSurfaceId)}</a></span>`,
              )
              .join('')}</div>`
          : ''
      }
    </div>
    <div class="header-actions">${platformFilterHtml(source, defaultPlatform)}<button data-feedback-download type="button">Download feedback JSON</button></div>
  </header>
  <nav class="route-nav" aria-label="Screen navigation">
    ${previous ? `<a href="${escapeHtml(previous.id)}.html#surface-${escapeHtml(previous.id)}">← ${escapeHtml(previous.title)}</a>` : '<span></span>'}
    ${next ? `<a href="${escapeHtml(next.id)}.html#surface-${escapeHtml(next.id)}">${escapeHtml(next.title)} →</a>` : '<span></span>'}
  </nav>
  ${
    children.length > 0 || related.length > 0
      ? `<nav class="surface-links" aria-label="Linked surfaces">
    ${
      children.length > 0
        ? `<section><h2>Subscreens</h2><div>${children
            .map(
              (child) =>
                `<a href="${escapeHtml(child.id)}.html#surface-${escapeHtml(child.id)}">${escapeHtml(child.title)}</a>`,
            )
            .join('')}</div></section>`
        : ''
    }
    ${
      related.length > 0
        ? `<section><h2>Related</h2><div>${related
            .map(
              (candidate) =>
                `<a href="${escapeHtml(candidate.id)}.html#surface-${escapeHtml(candidate.id)}">${escapeHtml(candidate.title)}</a>`,
            )
            .join('')}</div></section>`
        : ''
    }
  </nav>`
      : ''
  }
  <section class="screen-note">
    <label for="surface-note">Overall feedback for this surface</label>
    <textarea id="surface-note" data-surface-note="${escapeHtml(surface.id)}" placeholder="Describe changes that apply to the whole surface…"></textarea>
    <p data-feedback-status class="autosave">Feedback saves in this review session.</p>
  </section>
  <section class="platform-context" data-platform-context data-surface-title="${escapeHtml(surface.title)}" data-surface-platforms="${escapeHtml(surface.captures.map(({ platform }) => platform).join(','))}">
    <div><span>Screen</span><strong>${escapeHtml(surface.title)}</strong></div>
    <p data-platform-context-copy></p>
  </section>
  <p class="platform-empty" data-platform-empty hidden>The selected platform is not captured for this surface.</p>
  <main class="captures">${captures}</main>`,
  });
}

const stylesheet = `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #09090f; color: #f4f4f8; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; }
button { border: 1px solid #5555dd; border-radius: 8px; padding: 10px 14px; background: #3333aa; color: white; cursor: pointer; }
code { color: #aaaaff; overflow-wrap: anywhere; }
.board-header, .screen-header { display: flex; justify-content: space-between; align-items: start; gap: 20px; max-width: 1180px; margin: 0 auto 24px; }
.header-actions { display: flex; align-items: center; justify-content: end; gap: 10px; }
.platform-filter { display: inline-flex; padding: 3px; border: 1px solid #30304a; border-radius: 10px; background: #12121c; }
.platform-filter button { border: 0; border-radius: 7px; padding: 7px 11px; background: transparent; color: #aaaabb; }
.platform-filter button[aria-pressed="true"] { background: #3333aa; color: white; }
h1 { margin: 0 0 8px; }
h2 { margin: 0; font-size: 18px; }
p { color: #aaaabb; margin: 0; }
.screen-index { max-width: 1180px; margin: 0 auto; }
.navigation-map { display: grid; gap: 18px; }
.navigation-map__heading { display: flex; justify-content: space-between; align-items: start; gap: 20px; padding: 18px; border: 1px solid #2a2a3a; border-radius: 12px; background: #12121c; }
.navigation-map__heading h2 { margin-bottom: 6px; }
.navigation-map__tools { display: grid; justify-items: end; gap: 10px; }
.tree-actions { display: flex; gap: 8px; }
.tree-actions button { padding: 6px 10px; background: transparent; }
.navigation-legend { display: flex; flex-wrap: wrap; justify-content: end; gap: 7px; }
.navigation-kind { display: inline-flex; align-items: center; border: 1px solid #444466; border-radius: 999px; padding: 3px 7px; color: #d8d8ff; background: #202038; font-size: 11px; font-weight: 750; line-height: 1; text-transform: uppercase; }
.navigation-kind--push { border-color: #6153b8; background: #29204d; }
.navigation-kind--in-place { border-color: #287a68; background: #163d36; }
.navigation-kind--tab { border-color: #3a6899; background: #18334f; }
.navigation-kind--modal { border-color: #9a6631; background: #4d3219; }
.navigation-kind--replace { border-color: #944d65; background: #492332; }
.navigation-context { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
.navigation-context a { color: #cacaef; }
.navigation-paths { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 6px 8px; color: #aaaabb; font-size: 12px; }
.surface-tree { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 0; padding: 0; list-style: none; }
.surface-tree[hidden] { display: none; }
.surface-tree--nested { display: grid; grid-template-columns: 1fr; margin: 12px 0 0 18px; padding-left: 14px; border-left: 2px solid #30304a; }
.surface-tree:not(.surface-tree--nested) > .surface-node:has(> .surface-tree--nested) { grid-column: 1 / -1; }
.surface-tree:not(.surface-tree--nested) > .surface-node:has(> .surface-tree--nested) > .surface-node__row .screen-link { max-width: 360px; }
.surface-tree--nested .screen-link { width: 100%; max-width: 640px; min-height: 0; }
.surface-node__row { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 8px; align-items: start; }
.surface-toggle, .surface-toggle-spacer { width: 32px; height: 32px; margin-top: 8px; }
.surface-toggle { display: grid; place-items: center; padding: 0; border-color: #30304a; background: #12121c; }
.surface-toggle:hover, .surface-toggle:focus-visible { border-color: #6666ee; }
.surface-toggle__icon { font-size: 24px; line-height: 1; transition: transform 120ms ease; }
.surface-toggle[aria-expanded="true"] .surface-toggle__icon { transform: rotate(90deg); }
.screen-link { display: grid; gap: 10px; min-height: 160px; padding: 18px; border: 1px solid #2a2a3a; border-radius: 12px; background: #12121c; color: inherit; text-decoration: none; }
.screen-link:hover, .screen-link:focus-visible { border-color: #6666ee; background: #171724; }
.screen-link[data-platform-available="false"] { opacity: 0.55; }
.screen-link__meta { display: flex; justify-content: space-between; gap: 16px; color: #a5a5b8; font-size: 12px; text-transform: uppercase; }
.platforms { display: flex; flex-wrap: wrap; gap: 8px; align-self: end; }
.platforms span { border: 1px solid #30304a; border-radius: 999px; color: #cacaef; padding: 4px 8px; font-size: 12px; text-transform: uppercase; }
.platforms span[aria-current="true"] { border-color: #6666ee; background: #252553; color: white; }
.breadcrumbs { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; color: #85859a; font-size: 13px; }
.breadcrumbs a, .route-nav a, .surface-links a { color: #cacaef; text-decoration: none; }
.route-nav { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 1180px; margin: 0 auto 20px; }
.route-nav a:last-child { text-align: right; }
.surface-links { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; max-width: 1180px; margin: 0 auto 20px; }
.surface-links section { padding: 14px 18px; border: 1px solid #2a2a3a; border-radius: 12px; background: #12121c; }
.surface-links h2 { margin-bottom: 10px; font-size: 13px; color: #85859a; text-transform: uppercase; }
.surface-links section div { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.screen-note { display: grid; gap: 10px; max-width: 1180px; margin: 0 auto 24px; padding: 18px; border: 1px solid #2a2a3a; border-radius: 12px; background: #12121c; }
.screen-note label { font-weight: 650; }
.screen-note textarea { min-height: 100px; }
.captures { display: grid; gap: 24px; max-width: 1180px; margin: 0 auto; }
.captures[data-platform-comparison="true"] { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
.platform-context { display: flex; justify-content: space-between; align-items: center; gap: 20px; max-width: 1180px; margin: 0 auto 16px; padding: 14px 18px; border: 1px solid #30304a; border-radius: 12px; background: #12121c; }
.platform-context div { display: grid; gap: 3px; }
.platform-context span, .capture__header span { color: #85859a; font-size: 11px; font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; }
.platform-context strong { font-size: 15px; }
.platform-empty { max-width: 1180px; margin: 0 auto 24px; padding: 18px; border: 1px solid #4b3e2c; border-radius: 12px; background: #241d14; color: #e8c98c; }
.capture { display: grid; grid-template-columns: minmax(280px, 720px) minmax(280px, 420px); justify-content: center; align-items: start; overflow: clip; border: 1px solid #2a2a3a; border-radius: 12px; background: #12121c; }
.capture[hidden] { display: none; }
.capture__header { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 18px; border-bottom: 1px solid #2a2a3a; background: #171722; }
.capture__header div { display: grid; gap: 3px; }
.capture__header h2 { font-size: 16px; }
.capture__image { min-width: 0; background: #050508; }
.annotation-stage { position: relative; width: 100%; cursor: crosshair; }
.annotation-stage[data-mode="area"] { cursor: crosshair; touch-action: none; }
.annotation-stage img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
.annotation-markers { position: absolute; inset: 0; pointer-events: none; }
.annotation-marker { position: absolute; width: 28px; height: 28px; padding: 0; transform: translate(-50%, -50%); border: 2px solid white; border-radius: 50%; background: var(--annotation-color, #5855ee); font-size: 12px; font-weight: 750; pointer-events: auto; touch-action: none; }
.annotation-area { position: absolute; display: grid; place-items: start; min-width: 18px; min-height: 18px; padding: 3px; border: 2px solid var(--annotation-color, #8c8aff); border-radius: 5px; background: color-mix(in srgb, var(--annotation-color, #5855ee) 18%, transparent); color: white; font-size: 12px; font-weight: 750; pointer-events: auto; touch-action: none; }
.annotation-area--draft { border-style: dashed; pointer-events: none; }
.capture__notes { position: sticky; top: 24px; display: grid; gap: 12px; padding: 18px; }
.captures[data-platform-comparison="true"] .capture { display: block; }
.captures[data-platform-comparison="true"] .capture__notes { position: static; }
.annotation-tools { display: flex; gap: 8px; }
.annotation-tools button { padding: 6px 10px; background: transparent; }
.annotation-tools button[aria-pressed="true"] { background: #3333aa; }
.annotation-help { font-size: 13px; }
.annotation-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.annotation-item { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: start; }
.annotation-number { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #5855ee; font-size: 12px; font-weight: 750; }
.annotation-editor { display: grid; gap: 8px; }
.annotation-color { display: flex; align-items: center; gap: 8px; color: #aaaabb; font-size: 12px; }
.annotation-color input { width: 34px; height: 24px; padding: 0; border: 0; background: transparent; cursor: pointer; }
.annotation-item textarea { min-height: 88px; }
.annotation-remove { border-color: #4a3340; background: transparent; color: #e8b9c9; padding: 6px 8px; }
textarea { width: 100%; resize: vertical; border: 1px solid #333348; border-radius: 8px; padding: 12px; background: #09090f; color: inherit; font: inherit; }
.autosave { color: #85859a; font-size: 12px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) {
  body { padding: 12px; }
  .board-header, .screen-header { display: grid; }
  .header-actions { display: grid; justify-content: stretch; }
  .platform-filter { justify-content: stretch; }
  .platform-filter button { flex: 1; }
  .capture { display: block; }
  .capture__header, .platform-context { display: grid; }
  .capture__notes { position: static; }
  .navigation-map__heading { display: grid; }
  .navigation-map__tools { justify-items: start; }
  .navigation-legend { justify-content: start; }
  .surface-tree--nested { margin-left: 8px; padding-left: 8px; }
}
@media (max-width: 980px) {
  .captures[data-platform-comparison="true"] { grid-template-columns: 1fr; }
}
`;

function clientScript(reviewSource) {
  return `
(() => {
  const storageKey = document.body.dataset.feedbackKey;
  const source = ${JSON.stringify(reviewSource)};
  const platformStorageKey = storageKey + ':platform';
  const platforms = document.body.dataset.platforms.split(',').filter(Boolean);
  const defaultPlatform = document.body.dataset.defaultPlatform;
  const savedPlatform = localStorage.getItem(platformStorageKey);
  let platformFilter = savedPlatform === 'all' || platforms.includes(savedPlatform)
    ? savedPlatform
    : platforms.includes(defaultPlatform)
      ? defaultPlatform
      : platforms[0] || 'all';
  let annotationMode = 'point';
  const annotationPalette = ['#5855ee', '#e84a8a', '#20b486', '#f29d38', '#38a9f2', '#b266e8'];
  const annotationColor = (annotation) => {
    if (/^#[0-9a-f]{6}$/iu.test(annotation.color || '')) return annotation.color;
    const numericId = Number(/^annotation-(\\d+)$/u.exec(annotation.id)?.[1] || 1);
    return annotationPalette[(numericId - 1) % annotationPalette.length];
  };
  const platformName = (platform) => ({ ios: 'iOS', android: 'Android', web: 'Web' })[platform] || platform;

  const applyPlatformFilter = (platform) => {
    platformFilter = platform;
    document.body.dataset.activePlatform = platform;
    localStorage.setItem(platformStorageKey, platform);
    for (const button of document.querySelectorAll('[data-platform-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.platformFilter === platform));
    }
    for (const capture of document.querySelectorAll('[data-capture-platform]')) {
      capture.hidden = platform !== 'all' && capture.dataset.capturePlatform !== platform;
    }
    for (const card of document.querySelectorAll('.screen-link[data-surface-platforms]')) {
      const available = card.dataset.surfacePlatforms.split(',').filter(Boolean);
      const matches = platform === 'all' || available.includes(platform);
      card.dataset.platformAvailable = String(matches);
      const count = platform === 'all' ? available.length : Number(matches);
      const label = card.querySelector('[data-surface-capture-count]');
      if (label) label.textContent = count > 0 ? count + ' capture' + (count === 1 ? '' : 's') : 'not captured';
      for (const badge of card.querySelectorAll('[data-platform]')) {
        badge.setAttribute('aria-current', String(platform !== 'all' && badge.dataset.platform === platform));
      }
    }
    const visibleCaptures = [...document.querySelectorAll('[data-capture-platform]')].filter(
      (capture) => !capture.hidden,
    );
    const empty = document.querySelector('[data-platform-empty]');
    if (empty) empty.hidden = visibleCaptures.length > 0;
    const context = document.querySelector('[data-platform-context]');
    const contextCopy = context?.querySelector('[data-platform-context-copy]');
    const captures = document.querySelector('.captures');
    if (captures) captures.dataset.platformComparison = String(platform === 'all');
    if (context && contextCopy) {
      const available = context.dataset.surfacePlatforms.split(',').filter(Boolean);
      if (platform === 'all') {
        contextCopy.textContent = available.length > 1
          ? 'Same screen · separate ' + available.map(platformName).join(' and ') + ' captures. Runtime state may differ between capture sessions.'
          : 'Only the ' + platformName(available[0]) + ' capture is available for this surface.';
      } else if (available.includes(platform)) {
        contextCopy.textContent = 'Showing ' + context.dataset.surfaceTitle + ' · ' + platformName(platform) + '. Choose Compare platforms to view every captured platform.';
      } else {
        contextCopy.textContent = 'This surface was not captured on ' + platformName(platform) + '.';
      }
    }
  };

  for (const button of document.querySelectorAll('[data-platform-filter]')) {
    button.addEventListener('click', () => applyPlatformFilter(button.dataset.platformFilter));
  }
  applyPlatformFilter(platformFilter);

  const setSurfaceExpanded = (button, expanded) => {
    const children = document.getElementById(button.getAttribute('aria-controls'));
    if (!children) return;
    button.setAttribute('aria-expanded', String(expanded));
    children.hidden = !expanded;
    const label = button.querySelector('[data-toggle-label]');
    if (label) label.textContent = (expanded ? 'Collapse ' : 'Expand ') + button.dataset.surfaceTitle;
  };

  for (const button of document.querySelectorAll('[data-surface-toggle]')) {
    button.addEventListener('click', () => {
      setSurfaceExpanded(button, button.getAttribute('aria-expanded') !== 'true');
    });
  }
  for (const button of document.querySelectorAll('[data-tree-action]')) {
    button.addEventListener('click', () => {
      const expanded = button.dataset.treeAction === 'expand';
      for (const toggle of document.querySelectorAll('[data-surface-toggle]')) {
        setSurfaceExpanded(toggle, expanded);
      }
    });
  }

  const emptyFeedback = () => ({ surfaceNotes: {}, annotations: [] });
  const parseSaved = (value, label) => {
    if (!value) return emptyFeedback();
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          surfaceNotes: parsed.surfaceNotes && typeof parsed.surfaceNotes === 'object' ? parsed.surfaceNotes : {},
          annotations: Array.isArray(parsed.annotations)
            ? parsed.annotations.map((annotation) => ({ shape: 'point', ...annotation }))
            : [],
        };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    document.documentElement.dataset.feedbackWarning = 'Invalid ' + label + ' feedback was reset.';
    return emptyFeedback();
  };

  const stored = parseSaved(localStorage.getItem(storageKey), 'stored');
  const feedback = {
    surfaceNotes: stored.surfaceNotes,
    annotations: stored.annotations,
  };
  const currentSurfaceIds = new Set(source.surfaces.map((surface) => surface.id));
  const currentCaptureIds = new Set(
    source.surfaces.flatMap((surface) =>
      surface.captures.map((capture) => surface.id + ':' + capture.id),
    ),
  );

  const persist = () => {
    const serialized = JSON.stringify(feedback);
    localStorage.setItem(storageKey, serialized);
    for (const status of document.querySelectorAll('[data-feedback-status]')) status.textContent = 'Saved';
  };

  const setAnnotationMode = (mode) => {
    annotationMode = mode;
    for (const button of document.querySelectorAll('[data-annotation-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.annotationMode === mode));
    }
    for (const stage of document.querySelectorAll('[data-annotation-surface]')) stage.dataset.mode = mode;
    for (const help of document.querySelectorAll('[data-annotation-help]')) {
      help.textContent = mode === 'area'
        ? 'Drag across the screenshot to comment on an area.'
        : 'Click the screenshot to comment on a specific element.';
    }
  };

  for (const button of document.querySelectorAll('[data-annotation-mode]')) {
    button.addEventListener('click', () => setAnnotationMode(button.dataset.annotationMode));
  }
  setAnnotationMode(annotationMode);

  for (const field of document.querySelectorAll('[data-surface-note]')) {
    const surfaceId = field.dataset.surfaceNote;
    field.value = feedback.surfaceNotes[surfaceId] || '';
    field.addEventListener('input', () => {
      feedback.surfaceNotes[surfaceId] = field.value;
      persist();
    });
  }

  const renderCapture = (surfaceId, captureId) => {
    const surface = document.querySelector('[data-annotation-surface][data-capture-id="' + CSS.escape(captureId) + '"]');
    const list = document.querySelector('[data-annotation-list][data-capture-id="' + CSS.escape(captureId) + '"]');
    if (!surface || !list) return;
    const markers = surface.querySelector('.annotation-markers');
    const annotations = feedback.annotations.filter((item) => item.surfaceId === surfaceId && item.captureId === captureId);
    markers.replaceChildren();
    list.replaceChildren();
    annotations.forEach((annotation, index) => {
      const number = index + 1;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = annotation.shape === 'area' ? 'annotation-area' : 'annotation-marker';
      marker.dataset.annotationMarkerId = annotation.id;
      marker.textContent = String(number);
      marker.style.setProperty('--annotation-color', annotationColor(annotation));
      marker.style.left = annotation.x * 100 + '%';
      marker.style.top = annotation.y * 100 + '%';
      if (annotation.shape === 'area') {
        marker.style.width = annotation.width * 100 + '%';
        marker.style.height = annotation.height * 100 + '%';
      }
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        document.querySelector('[data-annotation-id="' + CSS.escape(annotation.id) + '"]')?.focus();
      });
      markers.append(marker);

      const item = document.createElement('li');
      item.className = 'annotation-item';
      const badge = document.createElement('span');
      badge.className = 'annotation-number';
      badge.textContent = String(number);
      badge.style.backgroundColor = annotationColor(annotation);
      const field = document.createElement('textarea');
      field.dataset.annotationId = annotation.id;
      field.placeholder = 'What should change here?';
      field.value = annotation.body;
      field.addEventListener('input', () => {
        annotation.body = field.value;
        persist();
      });
      const editor = document.createElement('div');
      editor.className = 'annotation-editor';
      const colorLabel = document.createElement('label');
      colorLabel.className = 'annotation-color';
      colorLabel.textContent = 'Color';
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = annotationColor(annotation);
      colorInput.addEventListener('input', () => {
        annotation.color = colorInput.value;
        marker.style.setProperty('--annotation-color', annotation.color);
        badge.style.backgroundColor = annotation.color;
        persist();
      });
      colorLabel.append(colorInput);
      editor.append(field, colorLabel);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'annotation-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        feedback.annotations = feedback.annotations.filter((candidate) => candidate.id !== annotation.id);
        persist();
        renderCapture(surfaceId, captureId);
      });
      item.append(badge, editor, remove);
      list.append(item);
    });
  };

  for (const surface of document.querySelectorAll('[data-annotation-surface]')) {
    const surfaceId = surface.dataset.surfaceId;
    const captureId = surface.dataset.captureId;
    renderCapture(surfaceId, captureId);
    let areaStart = null;
    let areaPointerId = null;
    let moveState = null;
    const imagePoint = (event, clampToImage = false) => {
      const image = surface.querySelector('img');
      const rect = image.getBoundingClientRect();
      if (!clampToImage && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return null;
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      };
    };
    const nextAnnotationId = () => 'annotation-' + (feedback.annotations.reduce((max, item) => {
      const match = /^annotation-(\\d+)$/.exec(item.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1);
    const focusAnnotation = (annotation) => {
      persist();
      setTimeout(() => {
        renderCapture(surfaceId, captureId);
        document
          .querySelector('[data-annotation-id="' + CSS.escape(annotation.id) + '"]')
          ?.focus();
      }, 0);
    };

    surface.addEventListener('click', (event) => {
      if (event.target.closest('.annotation-marker, .annotation-area')) return;
      if (annotationMode !== 'point') return;
      const point = imagePoint(event);
      if (!point) return;
      const annotation = {
        id: nextAnnotationId(),
        surfaceId,
        captureId,
        shape: 'point',
        ...point,
        color: annotationPalette[feedback.annotations.length % annotationPalette.length],
        body: '',
      };
      feedback.annotations.push(annotation);
      focusAnnotation(annotation);
    });

    surface.addEventListener('pointerdown', (event) => {
      const marker = event.target.closest('[data-annotation-marker-id]');
      if (marker) {
        const annotation = feedback.annotations.find(
          (candidate) => candidate.id === marker.dataset.annotationMarkerId,
        );
        if (!annotation) return;
        event.preventDefault();
        moveState = {
          annotation,
          marker,
          pointerId: event.pointerId,
          start: imagePoint(event, true),
          origin: { x: annotation.x, y: annotation.y },
        };
        surface.setPointerCapture(event.pointerId);
        return;
      }
      if (annotationMode !== 'area') return;
      const point = imagePoint(event);
      if (!point) return;
      event.preventDefault();
      areaStart = point;
      areaPointerId = event.pointerId;
      surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener('pointermove', (event) => {
      if (moveState && event.pointerId === moveState.pointerId) {
        event.preventDefault();
        const point = imagePoint(event, true);
        const deltaX = point.x - moveState.start.x;
        const deltaY = point.y - moveState.start.y;
        const maxX = moveState.annotation.shape === 'area' ? 1 - moveState.annotation.width : 1;
        const maxY = moveState.annotation.shape === 'area' ? 1 - moveState.annotation.height : 1;
        moveState.annotation.x = Math.max(0, Math.min(maxX, moveState.origin.x + deltaX));
        moveState.annotation.y = Math.max(0, Math.min(maxY, moveState.origin.y + deltaY));
        moveState.marker.style.left = moveState.annotation.x * 100 + '%';
        moveState.marker.style.top = moveState.annotation.y * 100 + '%';
        return;
      }
      if (!areaStart || event.pointerId !== areaPointerId) return;
      event.preventDefault();
      const point = imagePoint(event, true);
      const draft = document.createElement('span');
      draft.className = 'annotation-area annotation-area--draft';
      draft.style.left = Math.min(areaStart.x, point.x) * 100 + '%';
      draft.style.top = Math.min(areaStart.y, point.y) * 100 + '%';
      draft.style.width = Math.abs(point.x - areaStart.x) * 100 + '%';
      draft.style.height = Math.abs(point.y - areaStart.y) * 100 + '%';
      const markers = surface.querySelector('.annotation-markers');
      markers.querySelector('.annotation-area--draft')?.remove();
      markers.append(draft);
    });
    surface.addEventListener('pointerup', (event) => {
      if (moveState && event.pointerId === moveState.pointerId) {
        event.preventDefault();
        moveState = null;
        surface.releasePointerCapture(event.pointerId);
        persist();
        return;
      }
      if (!areaStart || event.pointerId !== areaPointerId) return;
      event.preventDefault();
      const point = imagePoint(event, true);
      const start = areaStart;
      areaStart = null;
      areaPointerId = null;
      surface.releasePointerCapture(event.pointerId);
      surface.querySelector('.annotation-area--draft')?.remove();
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);
      if (width < 0.01 || height < 0.01) return;
      const annotation = {
        id: nextAnnotationId(),
        surfaceId,
        captureId,
        shape: 'area',
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width,
        height,
        color: annotationPalette[feedback.annotations.length % annotationPalette.length],
        body: '',
      };
      feedback.annotations.push(annotation);
      focusAnnotation(annotation);
    });
    surface.addEventListener('pointercancel', (event) => {
      if (moveState && event.pointerId === moveState.pointerId) {
        moveState.annotation.x = moveState.origin.x;
        moveState.annotation.y = moveState.origin.y;
        moveState = null;
        renderCapture(surfaceId, captureId);
        return;
      }
      if (event.pointerId !== areaPointerId) return;
      areaStart = null;
      areaPointerId = null;
      surface.querySelector('.annotation-area--draft')?.remove();
    });
  }

  const feedbackDocument = () => ({
    version: 1,
    kind: 'visual-review-feedback',
    source,
    surfaceNotes: Object.entries(feedback.surfaceNotes)
      .filter(([surfaceId, body]) => currentSurfaceIds.has(surfaceId) && body.trim())
      .map(([surfaceId, body]) => ({ surfaceId, body })),
    annotations: feedback.annotations.filter(
      (annotation) =>
        currentCaptureIds.has(annotation.surfaceId + ':' + annotation.captureId) &&
        annotation.body.trim(),
    ),
  });

  for (const button of document.querySelectorAll('[data-feedback-download]')) {
    button.addEventListener('click', () => {
      persist();
      const blob = new Blob([JSON.stringify(feedbackDocument(), null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'visual-feedback.json';
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }
})();
`;
}

export function generateReviewBoard({ outputDir, source, storageKey, defaultPlatform }) {
  const normalizedSource = {
    ...source,
    surfaces: source.surfaces.map((surface) => ({
      ...surface,
      id: safeFileId(surface.id, 'Surface id'),
      ...(surface.parentId ? { parentId: safeFileId(surface.parentId, 'Parent surface id') } : {}),
      ...(surface.relatedSurfaceIds
        ? {
            relatedSurfaceIds: surface.relatedSurfaceIds.map((id) =>
              safeFileId(id, 'Related surface id'),
            ),
          }
        : {}),
      captures: surface.captures.map((capture) => ({
        ...capture,
        id: safeFileId(capture.id, 'Capture id'),
        platform: safeFileId(capture.platform, 'Platform'),
      })),
    })),
  };
  validateSurfaceRelationships(normalizedSource.surfaces);
  const platforms = sourcePlatforms(normalizedSource);
  const normalizedDefaultPlatform = platforms.includes(defaultPlatform)
    ? defaultPlatform
    : (platforms[0] ?? '');
  const renderedClientScript = clientScript(normalizedSource);
  const assetVersion = createHash('sha256')
    .update(stylesheet)
    .update('\0')
    .update(renderedClientScript)
    .digest('hex')
    .slice(0, 16);
  const assetsDir = path.join(outputDir, 'assets');
  const screensDir = path.join(outputDir, 'screens');
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(screensDir, { recursive: true });
  for (const entry of readdirSync(screensDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) {
      rmSync(path.join(screensDir, entry.name));
    }
  }

  writeFileSync(
    path.join(outputDir, 'visual-review-source.json'),
    `${JSON.stringify(normalizedSource, null, 2)}\n`,
  );
  writeFileSync(path.join(assetsDir, 'review-board.css'), stylesheet);
  writeFileSync(path.join(assetsDir, 'review-board.js'), renderedClientScript);
  writeFileSync(
    path.join(outputDir, 'index.html'),
    indexHtml(normalizedSource, storageKey, normalizedDefaultPlatform, assetVersion),
  );
  normalizedSource.surfaces.forEach((surface, index) => {
    writeFileSync(
      path.join(screensDir, `${surface.id}.html`),
      screenHtml(
        normalizedSource,
        storageKey,
        normalizedDefaultPlatform,
        surface,
        index,
        assetVersion,
      ),
    );
  });
}

function validateSurfaceRelationships(surfaces) {
  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  if (byId.size !== surfaces.length) throw new Error('Visual review surface ids must be unique.');
  for (const surface of surfaces) {
    for (const target of [surface.parentId, ...(surface.relatedSurfaceIds ?? [])].filter(Boolean)) {
      if (!byId.has(target)) {
        throw new Error(
          `Visual review surface ${surface.id} references missing surface ${target}.`,
        );
      }
    }
    const seen = new Set();
    let current = surface;
    while (current?.parentId) {
      if (seen.has(current.id)) {
        throw new Error(`Visual review surface hierarchy contains a cycle at ${surface.id}.`);
      }
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }
}
