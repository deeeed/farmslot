#!/usr/bin/env node
/**
 * Offline UX catalog HTML report for Companion screenshot captures.
 * One card per screen: image (when present), route id/path, title, note placeholder.
 *
 * Usage:
 *   node generate-ux-catalog-html.mjs --output-dir <dir>
 *   node generate-ux-catalog-html.mjs --output-dir <dir> --platforms ios,android
 */
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_TITLES = {
  '01_review': 'Review',
  '02_terminals': 'Terminals',
  '03_advanced': 'Advanced',
  '04_settings': 'Settings',
  '05_raw_fleet': 'Advanced · Fleet',
  '06_raw_prs': 'Advanced · PRs',
  '07_raw_inbox': 'Advanced · Inbox',
  '10_run_detail': 'Run detail',
  '11_run_evidence': 'Run evidence / artifacts',
  '12_run_diff': 'Run diff',
  '20_slot_workspace': 'Slot workspace',
  '21_slot_terminal': 'Slot terminal',
  '22_slot_diff': 'Slot diff',
  '23_worker_terminal': 'Worker terminal',
  '30_family_workspace': 'Family workspace',
  '40_decision': 'Decision workspace',
};

function parseArgs(argv) {
  const out = { outputDir: null, platforms: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output-dir') {
      out.outputDir = argv[++i];
    } else if (arg.startsWith('--output-dir=')) {
      out.outputDir = arg.slice('--output-dir='.length);
    } else if (arg === '--platforms') {
      out.platforms = argv[++i];
    } else if (arg.startsWith('--platforms=')) {
      out.platforms = arg.slice('--platforms='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: generate-ux-catalog-html.mjs --output-dir <dir> [--platforms ios,android]',
      );
      process.exit(0);
    }
  }
  if (!out.outputDir) {
    console.error('ERROR: --output-dir is required');
    process.exit(1);
  }
  return out;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseRouteSpec(spec) {
  const pipe = spec.indexOf('|');
  if (pipe === -1) {
    return { key: spec, routePath: spec };
  }
  return {
    key: spec.slice(0, pipe),
    routePath: spec.slice(pipe + 1),
  };
}

function discoverPlatforms(outputDir, requested) {
  if (requested) {
    return requested
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }
  const found = [];
  for (const name of ['ios', 'android', 'catalog']) {
    const dir = path.join(outputDir, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      found.push(name);
    }
  }
  return found.length > 0 ? found : ['catalog'];
}

function loadManifest(outputDir) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${outputDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const routes = Array.isArray(raw.routes) ? raw.routes.map(String) : [];
  return { raw, routes, manifestPath };
}

function cardHtml({ key, routePath, title, platform, imageRel, noteId }) {
  const imageBlock = imageRel
    ? `<a class="thumb-link" href="${escapeHtml(imageRel)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(imageRel)}" alt="${escapeHtml(title)} (${escapeHtml(platform)})" loading="lazy" />
      </a>`
    : `<div class="thumb missing">No screenshot<br/><span class="muted">${escapeHtml(platform)}</span></div>`;

  return `<article class="card" data-route-key="${escapeHtml(key)}" data-route-path="${escapeHtml(routePath)}" data-platform="${escapeHtml(platform)}">
  <div class="thumb-wrap">${imageBlock}</div>
  <div class="meta">
    <h2>${escapeHtml(title)}</h2>
    <dl>
      <div><dt>Route id</dt><dd><code>${escapeHtml(key)}</code></dd></div>
      <div><dt>Path</dt><dd><code>${escapeHtml(routePath)}</code></dd></div>
      <div><dt>Platform</dt><dd>${escapeHtml(platform)}</dd></div>
    </dl>
    <label class="note-label" for="${escapeHtml(noteId)}">Notes / assessment</label>
    <textarea id="${escapeHtml(noteId)}" class="note" rows="4" placeholder="Free-text UX notes for this screen…"></textarea>
  </div>
</article>`;
}

function buildHtml({ capturedAt, variant, routes, platforms, outputDir }) {
  const cards = [];
  for (const platform of platforms) {
    for (const spec of routes) {
      const { key, routePath } = parseRouteSpec(spec);
      const title = ROUTE_TITLES[key] ?? key;
      const imageName = `${key}.png`;
      const imageAbs = path.join(outputDir, platform, imageName);
      const imageRel = fs.existsSync(imageAbs) ? `${platform}/${imageName}` : null;
      const noteId = `note-${platform}-${key}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      cards.push(cardHtml({ key, routePath, title, platform, imageRel, noteId }));
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Companion UX catalog</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d12;
      --card: #151922;
      --border: #2a3140;
      --text: #e8ecf4;
      --muted: #9aa3b5;
      --accent: #7aa2ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
      background: #10141c;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    header h1 { margin: 0 0 0.35rem; font-size: 1.25rem; }
    header p { margin: 0.15rem 0; color: var(--muted); font-size: 0.9rem; }
    main {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
      padding: 1.25rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .thumb-wrap { background: #0a0c10; min-height: 180px; }
    .thumb-link img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 420px;
      object-fit: contain;
      background: #000;
    }
    .thumb.missing {
      min-height: 180px;
      display: grid;
      place-content: center;
      text-align: center;
      color: var(--muted);
      font-size: 0.9rem;
      padding: 1rem;
    }
    .meta { padding: 0.9rem 1rem 1rem; display: grid; gap: 0.55rem; }
    .meta h2 { margin: 0; font-size: 1.05rem; }
    dl { margin: 0; display: grid; gap: 0.35rem; }
    dl > div { display: grid; grid-template-columns: 5.5rem 1fr; gap: 0.4rem; align-items: baseline; }
    dt { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    dd { margin: 0; font-size: 0.85rem; overflow-wrap: anywhere; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      color: var(--accent);
    }
    .note-label { font-size: 0.8rem; color: var(--muted); }
    .note {
      width: 100%;
      resize: vertical;
      min-height: 4.5rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #0d1118;
      color: var(--text);
      padding: 0.55rem 0.65rem;
      font: inherit;
    }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>Companion UX catalog</h1>
    <p>Offline-openable screen catalog for design review. Notes stay local in this file (not synced).</p>
    <p>Captured: <strong>${escapeHtml(capturedAt ?? 'unknown')}</strong> · Variant: <strong>${escapeHtml(variant ?? 'unknown')}</strong></p>
    <p>Routes: <strong>${routes.length}</strong> · Platforms: <strong>${escapeHtml(platforms.join(', '))}</strong></p>
  </header>
  <main>
    ${cards.join('\n    ')}
  </main>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.outputDir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const { raw, routes } = loadManifest(outputDir);
  if (routes.length === 0) {
    throw new Error('manifest.json has no routes');
  }
  const platforms = discoverPlatforms(outputDir, args.platforms);
  for (const platform of platforms) {
    fs.mkdirSync(path.join(outputDir, platform), { recursive: true });
  }
  const html = buildHtml({
    capturedAt: raw.capturedAt,
    variant: raw.variant,
    routes,
    platforms,
    outputDir,
  });
  const outPath = path.join(outputDir, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`[ux-catalog-html] wrote ${outPath} (${routes.length} routes × ${platforms.length} platform(s))`);
}

main();
