import { createSha256, RESOURCE_CONTENT_LIMITS } from './content.js';
import type { GatewayResourceCache } from './types.js';

export interface StoredArtifactRead {
  current(): GatewayResourceCache | undefined;
  url: string;
  online: boolean;
  read(): Promise<Response>;
  signal?: AbortSignal;
  /** Explicit reloads wait for fresh bytes; ordinary display opens saved bytes immediately. */
  refresh?: boolean;
  onStored?(response: Response): unknown;
  onRefreshError?(error: unknown | undefined): void;
}

function textResponse(data: Uint8Array, init?: ResponseInit): Response {
  const response = new Response(data.slice().buffer, init);
  // React Native's Response polyfill decodes ArrayBuffers one byte per character.
  Object.defineProperty(response, 'text', { value: async () => new TextDecoder().decode(data) });
  return response;
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
  refresh = false,
  onRefreshError,
  onStored,
}: StoredArtifactRead): Promise<Response> {
  const cache = current();
  if (!cache) throw new Error('The offline store is not open yet');
  const source = new URL(url, 'https://artifact.invalid');
  if (source.pathname !== '/api/run-artifact') throw new Error('Expected a retained artifact URL');
  refresh ||= source.searchParams.has('m');
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
  if (held && !online) return textResponse(held);
  if (!online) throw new Error('This artifact has not been stored on this device');
  const fetchFresh = async () => {
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
    return textResponse(data, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  if (held && !refresh && onStored) {
    await onStored(textResponse(held));
    assertCurrent();
    try {
      const response = await fetchFresh();
      if (response.status >= 500 && onRefreshError) {
        onRefreshError(new Error(`HTTP ${response.status}`));
        return textResponse(held);
      }
      onRefreshError?.(response.ok ? undefined : new Error(`HTTP ${response.status}`));
      return response;
    } catch (error) {
      assertCurrent();
      if (!onRefreshError) throw error;
      onRefreshError(error);
      return textResponse(held);
    }
  }
  if (held && !refresh && onRefreshError) {
    // The saved response is the display fallback. Report refresh failures separately so
    // temporary network loss cannot hide it or leave a rejected background promise.
    void fetchFresh().then(
      (response) => onRefreshError(response.ok ? undefined : new Error(`HTTP ${response.status}`)),
      (error: unknown) => {
        if (
          cache === current() &&
          !signal?.aborted &&
          cache.contentWriteToken().ownerVersion === token.ownerVersion
        )
          onRefreshError(error);
      },
    );
    return textResponse(held);
  }
  return fetchFresh();
}
