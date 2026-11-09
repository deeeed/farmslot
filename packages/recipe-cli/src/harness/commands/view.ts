// `recipe view <run-dir>`: a read-only local HTTP server for one run's evidence page, its
// sibling runs and the files they retained. It binds loopback only and never writes.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import {
  isRecipeRunFolder,
  listRunEvidenceHistory,
  readRunEvidenceView,
  runEvidenceSignature,
} from '../evidence-view.js';
import {
  escapeHtml,
  formatCueMs,
  renderRunEvidencePage,
  renderRunHistoryPage,
  type RunEvidencePageContext,
  type RunEvidenceTemplate,
} from '../evidence-view-page.js';
import { isPathWithin } from '../paths.js';

export interface RunEvidenceServerOptions {
  /** A run folder, or a folder of runs. */
  dir: string;
  /** 0 picks a free port. */
  port?: number;
  template?: RunEvidenceTemplate;
}

export interface RunEvidenceServer {
  /** The page for the run folder given, or the history index for a folder of runs. */
  url: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const runPath = (id: string) => `/runs/${encodeURIComponent(id)}/`;

function fileUrl(id: string, file: string): string {
  return `${runPath(id)}files/${file.split('/').map(encodeURIComponent).join('/')}`;
}

function send(
  response: http.ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/** Stream one retained file, honouring a single byte range so the player can seek. */
function sendFile(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  file: string,
): void {
  const size = fs.statSync(file).size;
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      response.writeHead(416, { 'content-range': `bytes */${size}` });
      response.end();
      return;
    }
  }
  const partial = Boolean(range && (range[1] || range[2]));
  response.writeHead(partial ? 206 : 200, {
    'content-type': type,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file, { start, end }).pipe(response);
}

/** Serve the evidence page until `close`; resolves once listening. */
export async function serveRunEvidence(
  options: RunEvidenceServerOptions,
): Promise<RunEvidenceServer> {
  const dir = path.resolve(options.dir);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Not a directory: ${dir}`);
  const single = isRecipeRunFolder(dir);
  // History is the folder of runs: the run's parent, or the folder given.
  const root = single ? path.dirname(dir) : dir;
  const template = options.template;

  const runDir = (id: string): string | null => {
    if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) return null;
    const candidate = path.join(root, id);
    return isPathWithin(root, candidate) && isRecipeRunFolder(candidate) ? candidate : null;
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return send(response, 405, 'The run evidence viewer is read-only.');
    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (url.pathname === '/') {
      if (single) {
        response.writeHead(302, { location: runPath(path.basename(dir)) });
        return response.end();
      }
      return send(
        response,
        200,
        renderRunHistoryPage(root, listRunEvidenceHistory(root), {
          context: { escape: escapeHtml, runUrl: runPath },
          live: { versionUrl: '/version', version: runEvidenceSignature(root) },
          template,
        }),
        CONTENT_TYPES['.html'],
      );
    }
    if (url.pathname === '/version') return send(response, 200, runEvidenceSignature(root));
    if (segments[0] !== 'runs') return send(response, 404, 'Not found.');
    const id = segments[1] ?? '';
    const run = runDir(id);
    if (!run) return send(response, 404, 'No such run.');
    const rest = segments.slice(2);
    if (rest.length === 1 && rest[0] === 'version')
      return send(response, 200, runEvidenceSignature(run));
    if (rest[0] === 'files') {
      const file = path.join(run, ...rest.slice(1));
      if (
        rest.length < 2 ||
        !isPathWithin(run, file) ||
        !fs.statSync(file, { throwIfNoEntry: false })?.isFile()
      )
        return send(response, 404, 'No such file in this run.');
      return sendFile(request, response, file);
    }
    const view = await readRunEvidenceView(run);
    if (rest.length === 1 && rest[0] === 'view.json')
      return send(response, 200, `${JSON.stringify(view, null, 2)}\n`, CONTENT_TYPES['.json']);
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== ''))
      return send(response, 404, 'Not found.');
    const context: RunEvidencePageContext = {
      fileUrl: (file) => fileUrl(id, file),
      runUrl: runPath,
      escape: escapeHtml,
      formatMs: formatCueMs,
      seekAttributes: (cue) =>
        `data-seek-video="${escapeHtml(cue.videoPath)}" data-seek-ms="${Math.round(cue.startMs)}"`,
      history: listRunEvidenceHistory(root),
    };
    const live =
      view.run?.status === 'running'
        ? { versionUrl: `${runPath(id)}version`, version: runEvidenceSignature(run) }
        : null;
    return send(
      response,
      200,
      renderRunEvidencePage(view, { context, live, template }),
      CONTENT_TYPES['.html'],
    );
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        send(response, 500, error instanceof Error ? error.message : String(error));
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: single ? `${base}${runPath(path.basename(dir))}` : `${base}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
