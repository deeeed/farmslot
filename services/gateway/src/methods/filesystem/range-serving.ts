// methods/filesystem/range-serving.ts — MIME and HTTP byte-range serving helpers.

import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  // Web bundle assets — the Command Center UI is served from the gateway.
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

type ByteRange = {
  start: number;
  end: number;
};

type ParsedByteRange = ByteRange | 'unsatisfiable' | null;

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function parseRequestByteRange(req: IncomingMessage, size: number): ParsedByteRange {
  const rawRange = req.headers.range;
  const rangeHeader = Array.isArray(rawRange) ? rawRange[0] : rawRange;
  if (!rangeHeader) return null;
  if (!Number.isSafeInteger(size) || size < 0) return 'unsatisfiable';
  if (!rangeHeader.startsWith('bytes=')) return 'unsatisfiable';

  const ranges = rangeHeader.slice('bytes='.length).split(',');
  if (ranges.length !== 1) return 'unsatisfiable';

  const match = ranges[0].trim().match(/^(\d*)-(\d*)$/);
  if (!match) return 'unsatisfiable';

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable';
  if (size === 0) return 'unsatisfiable';

  let start: number;
  let end: number;

  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'unsatisfiable';
    if (start < 0 || end < start || start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

function byteServingHeaders(mime: string, length: number): Record<string, string | number> {
  return {
    'Content-Type': mime,
    'Content-Length': length,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
}

function sendUnsatisfiableRange(res: ServerResponse, size: number): void {
  res.writeHead(416, {
    'Content-Type': 'text/plain',
    'Content-Range': `bytes */${size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  res.end('Requested Range Not Satisfiable');
}

export function serveBufferWithRange(
  req: IncomingMessage,
  res: ServerResponse,
  buffer: Buffer,
  mime: string,
): void {
  const range = parseRequestByteRange(req, buffer.length);
  if (range === 'unsatisfiable') {
    sendUnsatisfiableRange(res, buffer.length);
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...byteServingHeaders(mime, length),
      'Content-Range': `bytes ${range.start}-${range.end}/${buffer.length}`,
    });
    res.end(buffer.subarray(range.start, range.end + 1));
    return;
  }

  res.writeHead(200, byteServingHeaders(mime, buffer.length));
  res.end(buffer);
}

export function serveLocalFileWithRange(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  mime: string,
  size: number,
): void {
  const range = parseRequestByteRange(req, size);
  if (range === 'unsatisfiable') {
    sendUnsatisfiableRange(res, size);
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...byteServingHeaders(mime, length),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, byteServingHeaders(mime, size));
  createReadStream(filePath).pipe(res);
}
