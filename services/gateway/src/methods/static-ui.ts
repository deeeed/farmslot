// methods/static-ui.ts — serve the built Command Center UI bundle from the gateway.
//
// An installed farmslot runs `vite build` once; the gateway then serves the SPA
// on its own HTTP port so the dashboard and the WebSocket API share one origin
// (the UI derives ws://<host>/ws from window.location). No vite dev server at
// runtime. A dev gateway with no bundle present falls through to a 404 unchanged.
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';

import { farmslotRoot } from '../core/index.js';

import { mimeForPath } from './filesystem/range-serving.js';

const UI_DIST = resolve(farmslotRoot, 'apps', 'command-center', 'ui', 'dist');
const INDEX_HTML = join(UI_DIST, 'index.html');

/**
 * Serve a GET request from the built UI bundle. Returns false (caller 404s) when
 * no bundle exists. With a bundle present, real files are served directly and any
 * other path falls back to index.html so the SPA's client-side routes resolve.
 */
export function serveStaticUi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!existsSync(INDEX_HTML)) return false;

  let requestPath: string;
  try {
    requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    // Malformed percent-encoding is never a real asset — let the caller 404.
    return false;
  }

  const candidate = normalize(join(UI_DIST, requestPath));
  // Reject path traversal: the resolved file must stay inside UI_DIST.
  const inside = candidate === UI_DIST || candidate.startsWith(UI_DIST + sep);
  const isFile = inside && existsSync(candidate) && statSync(candidate).isFile();
  const target = isFile ? candidate : INDEX_HTML;

  // Vite fingerprints asset filenames (immutable); index.html must revalidate so
  // a fresh build is picked up on the next load.
  res.writeHead(200, {
    'Content-Type': mimeForPath(target),
    'Cache-Control': target === INDEX_HTML ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  const stream = createReadStream(target);
  stream.on('error', (err) => {
    console.error(`[static-ui] read error ${target}: ${err.message}`);
    res.end();
  });
  stream.pipe(res);
  return true;
}
