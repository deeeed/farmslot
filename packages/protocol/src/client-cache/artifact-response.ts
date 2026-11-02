import { createSha256, RESOURCE_CONTENT_LIMITS } from './content.js';
import type { GatewayResourceCache } from './types.js';

export interface StoredArtifactRead {
  current(): GatewayResourceCache | undefined;
  url: string;
  online: boolean;
  read(): Promise<Response>;
  signal?: AbortSignal;
}

function digest(data: Uint8Array): string {
  const hash = createSha256();
  hash.update(data);
  return hash.hex();
}

/** Retained text uses the same verified, bounded content store as images and files. */
export async function readStoredArtifactResponse({
  current,
  url,
  online,
  read,
  signal,
}: StoredArtifactRead): Promise<Response> {
  const cache = current();
  if (!cache) throw new Error('The offline store is not open yet');
  const source = new URL(url, 'https://artifact.invalid');
  if (source.pathname !== '/api/run-artifact') throw new Error('Expected a retained artifact URL');
  // Mirror refresh is an explicit reread, not part of the retained file's identity.
  for (const name of ['token', 'password', 'm']) source.searchParams.delete(name);
  source.hash = '';
  source.searchParams.sort();
  // No URL, query credential or document body is written into an alias.
  const alias = `artifact-response:${digest(new TextEncoder().encode(source.href))}`;
  const token = cache.contentWriteToken();
  const assertCurrent = () => {
    if (signal?.aborted)
      throw Object.assign(new Error('Artifact read aborted'), { name: 'AbortError' });
    if (cache !== current() || cache.contentWriteToken().ownerVersion !== token.ownerVersion)
      throw new Error('The artifact source changed');
  };
  assertCurrent();
  const held = await cache.openContentByAlias(alias);
  assertCurrent();
  if (held && !online) return new Response(held.slice().buffer);
  if (!online) throw new Error('This artifact has not been stored on this device');
  const response = await read();
  assertCurrent();
  if (!response.ok) {
    if (held && (response.status === 401 || response.status === 403))
      await cache.forgetContent({ kind: 'artifact', id: digest(held) });
    return response;
  }
  const data = new Uint8Array(await response.arrayBuffer());
  assertCurrent();
  // Over-cap files remain the named large-media exception and are fetched only on open.
  if (data.byteLength <= RESOURCE_CONTENT_LIMITS.fileBytes)
    await cache.storeContent({
      key: { kind: 'artifact', id: digest(data) },
      data,
      alias,
      origin: 'opened',
      cohort: 'run',
      token,
    });
  assertCurrent();
  return new Response(data.slice().buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
