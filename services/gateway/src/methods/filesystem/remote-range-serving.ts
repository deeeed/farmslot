// Read HTTP byte ranges at the node so following a large log never downloads it all.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
  type NodeFsReadChunkResult,
} from '@farmslot/protocol';
import { getNode } from '../../fleet/machine-registry.js';
import { sendNodeRequest } from '../../fleet/node-rpc.js';
import {
  byteServingHeaders,
  parseRequestByteRange,
  sendUnsatisfiableRange,
} from './range-serving.js';

type Request = (method: string, params: unknown) => Promise<unknown>;

export async function serveRemoteRange(
  req: IncomingMessage,
  res: ServerResponse,
  file: { machine: string; root: string; relPath: string },
  mime: string,
  maxBytes: number,
  requestOverride?: Request,
): Promise<boolean> {
  if (!req.headers.range) return false;
  const node = requestOverride ? undefined : getNode(file.machine);
  if (!requestOverride && !node) throw new Error(`No node connected for machine ${file.machine}`);
  const request: Request =
    requestOverride ??
    ((method, params) =>
      sendNodeRequest(node!, method, params, { timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS }));
  const params = { root: file.root, relPath: file.relPath };
  const { size } = (await request('fs.stat', params)) as { size: number };
  const range = parseRequestByteRange(req, size);
  if (range === 'unsatisfiable') {
    sendUnsatisfiableRange(res, size);
    return true;
  }
  if (!range) return false;
  const length = range.end - range.start + 1;
  if (length > maxBytes) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end(`Remote byte range too large to proxy (${length} bytes)`);
    return true;
  }
  const chunks: Buffer[] = [];
  let offset = range.start;
  while (offset <= range.end) {
    const requested = Math.min(FILE_TRANSFER_CHUNK_MAX_BYTES, range.end - offset + 1);
    const chunk = (await request('fs.readChunk', {
      ...params,
      offset,
      length: requested,
    })) as NodeFsReadChunkResult;
    const bytes = Buffer.from(chunk.content, 'base64');
    if (chunk.offset !== offset || chunk.bytesRead !== requested || bytes.length !== requested)
      throw new Error('Remote file changed or returned an incomplete byte range');
    chunks.push(bytes);
    offset += requested;
  }
  res.writeHead(206, {
    ...byteServingHeaders(mime, length),
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'X-Farmslot-Transfer-Mode': 'range',
    'X-Farmslot-Read-Chunk-Count': String(chunks.length),
  });
  res.end(Buffer.concat(chunks, length));
  return true;
}
