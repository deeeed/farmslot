import * as FileSystem from 'expo-file-system/legacy';

import { base64Bytes } from '@farmslot/protocol/client-cache';

import type { EvidenceMediaFiles } from './evidence-media';

/** Held gate evidence in the app's documents directory, which the OS does not purge. */
export function nativeEvidenceMediaFiles(): EvidenceMediaFiles {
  const directory = `${FileSystem.documentDirectory}evidence-media/`;
  let ready: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(
      () => undefined,
    ));
  const size = async (uri: string) => {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? info.size : undefined;
  };
  return {
    directory,
    size,
    async download(source, to) {
      await ensure();
      const result = await FileSystem.downloadAsync(source.uri, to, { headers: source.headers });
      if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
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
  };
}
