#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (!process.argv[2]) throw new Error('Usage: generate-ux-catalog.mjs <screenshot-dir>');
const outputDir = path.resolve(process.argv[2]);

const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
const platforms = ['ios', 'android'].filter((platform) =>
  manifest.routes.some((route) => existsSync(path.join(outputDir, platform, `${route.id}.png`))),
);

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const cards = platforms
  .flatMap((platform) =>
    manifest.routes
      .filter((route) => existsSync(path.join(outputDir, platform, `${route.id}.png`)))
      .map(
        (route) => `
      <article id="${escapeHtml(`${platform}-${route.id}`)}" class="card${route.fullHeight ? ' full-height' : ''}">
        <a href="${platform}/${escapeHtml(route.id)}.png">
          <img src="${platform}/${escapeHtml(route.id)}.png" alt="${escapeHtml(route.title)} on ${platform}" loading="lazy">
        </a>
        <div class="copy">
          <div class="meta"><span>${escapeHtml(platform)}</span><code>${escapeHtml(route.id)}</code></div>
          <h2>${escapeHtml(route.title)}</h2>
          <code>${escapeHtml(route.path)}</code>
          <textarea data-key="${escapeHtml(`${platform}:${route.id}`)}" aria-label="Notes for ${escapeHtml(route.title)} on ${platform}" placeholder="What should change on this screen?"></textarea>
          <p class="autosave">Notes save in this browser. Download JSON when the review is ready to share.</p>
        </div>
      </article>`,
      ),
  )
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Companion UX catalog</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #09090f; color: #f4f4f8; }
    body { margin: 0; padding: 24px; }
    header { max-width: 760px; margin-bottom: 24px; }
    h1 { margin: 0 0 8px; }
    header p { color: #aaaabb; margin: 0; }
  .toolbar { display: flex; gap: 12px; margin-top: 16px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    nav a { border: 1px solid #30304a; border-radius: 999px; color: #cacaef; padding: 6px 10px; text-decoration: none; }
    button { border: 1px solid #5555dd; border-radius: 8px; padding: 10px 14px; background: #3333aa; color: white; cursor: pointer; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
    .card { overflow: hidden; border: 1px solid #2a2a3a; border-radius: 12px; background: #12121c; }
    .card > a { display: block; min-width: 0; }
    .card img { display: block; width: 100%; max-height: 640px; object-fit: contain; background: #050508; }
    .card.full-height { display: grid; grid-column: 1 / -1; grid-template-columns: minmax(280px, 520px) minmax(280px, 420px); justify-content: center; align-items: start; }
    .card.full-height img { max-height: none; width: min(100%, 520px); margin: 0 auto; }
    .copy { display: grid; gap: 10px; padding: 16px; }
    .card.full-height .copy { position: sticky; top: 24px; }
    .meta { display: flex; justify-content: space-between; color: #a5a5b8; text-transform: uppercase; font-size: 12px; }
    h2 { margin: 0; font-size: 18px; }
    code { color: #aaaaff; overflow-wrap: anywhere; }
    textarea { min-height: 180px; resize: vertical; border: 1px solid #333348; border-radius: 8px; padding: 10px; background: #09090f; color: inherit; }
    .autosave { color: #85859a; font-size: 12px; margin: 0; }
    @media (max-width: 760px) {
      body { padding: 12px; }
      .card.full-height { display: block; }
      .card.full-height .copy { position: static; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Companion UX catalog</h1>
    <p>${escapeHtml(manifest.capturedAt)} · ${escapeHtml(manifest.variant)} · ${platforms.length} platform${platforms.length === 1 ? '' : 's'}</p>
    <div class="toolbar"><button id="download-feedback" type="button">Download feedback JSON</button></div>
    <nav>${platforms
      .flatMap((platform) =>
        manifest.routes
          .filter((route) => existsSync(path.join(outputDir, platform, `${route.id}.png`)))
          .map(
            (route) =>
              `<a href="#${escapeHtml(`${platform}-${route.id}`)}">${escapeHtml(`${platform} · ${route.title}`)}</a>`,
          ),
      )
      .join('')}</nav>
  </header>
  <main>${cards}</main>
  <script>
    const storageKey = 'farmslot-companion-ux-feedback';
    const fields = [...document.querySelectorAll('textarea[data-key]')];
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    for (const field of fields) {
      field.value = saved[field.dataset.key] || '';
      field.addEventListener('input', () => {
        saved[field.dataset.key] = field.value;
        localStorage.setItem(storageKey, JSON.stringify(saved));
      });
    }
    document.querySelector('#download-feedback').addEventListener('click', () => {
      const notes = Object.fromEntries(fields.map((field) => [field.dataset.key, field.value]));
      const blob = new Blob([JSON.stringify({ capturedAt: ${JSON.stringify(manifest.capturedAt)}, notes }, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'companion-ux-feedback.json';
      link.click();
      URL.revokeObjectURL(link.href);
    });
  </script>
</body>
</html>
`;

writeFileSync(path.join(outputDir, 'index.html'), html);
