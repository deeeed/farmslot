import * as FileSystem from 'expo-file-system/legacy';

import { base64Bytes, createSha256 } from '@farmslot/protocol/client-cache';

import type { EvidenceMediaFiles } from './evidence-media';

/**
 * One offline store scope's held gate evidence, in the cache directory: backups skip it, the OS
 * may reclaim it, and it is deleted with the scope's offline store (ADR-071).
 */
export function nativeEvidenceMediaFiles(scopeId: string): EvidenceMediaFiles {
  const hash = createSha256();
  hash.update(new TextEncoder().encode(scopeId));
  const directory = `${FileSystem.cacheDirectory}evidence-media/${hash.hex().slice(0, 16)}/`;
  let ready: Promise<void> | undefined;
  // `intermediates` makes an existing directory no error, so only a real failure rejects.
  const ensure = () =>
    (ready ??= FileSystem.makeDirectoryAsync(directory, { intermediates: true }));
  const size = async (uri: string) => {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? info.size : undefined;
  };
  return {
    directory,
    size,
    async download(source, to, signal) {
      await ensure();
      if (signal.aborted) throw new Error('Download cancelled');
      const task = FileSystem.createDownloadResumable(source.uri, to, { headers: source.headers });
      const cancel = () => void task.cancelAsync();
      signal.addEventListener('abort', cancel);
      try {
        const result = await task.downloadAsync();
        if (!result) throw new Error('Download cancelled');
        if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      return (await size(to)) ?? 0;
    },
    async read(uri, position, length) {
      return base64Bytes(
        await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        }),
      );
    },
    move: (from, to) => FileSystem.moveAsync({ from, to }),
    remove: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
    async readText(uri) {
      return (await size(uri)) === undefined ? undefined : FileSystem.readAsStringAsync(uri);
    },
    async writeText(uri, text) {
      await ensure();
      await FileSystem.writeAsStringAsync(uri, text);
    },
    async clear() {
      ready = undefined;
      await FileSystem.deleteAsync(directory, { idempotent: true });
    },
  };
}
