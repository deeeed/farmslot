import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validateConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Connection must be an object.');
  }
  if (Object.keys(value).some((key) => !['url', 'token', 'password'].includes(key))) {
    throw new Error('Unknown connection field.');
  }
  if (typeof value.url !== 'string' || value.url.length > 2048) {
    throw new Error('Enter a gateway WebSocket URL.');
  }
  const url = new URL(value.url);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use ws:// or wss:// without credentials, query parameters, or a fragment.');
  }
  const connection = { url: url.href };
  for (const key of ['token', 'password']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 16384) {
        throw new Error(`Invalid ${key}.`);
      }
      if (value[key]) connection[key] = value[key];
    }
  }
  if (connection.token && connection.password)
    throw new Error('Choose token or password authentication.');
  return connection;
}

export function createConnectionStore(directory, encryption) {
  const path = join(directory, 'connection.encrypted');
  return {
    async load() {
      let data;
      try {
        data = await readFile(path);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      if (!encryption.isEncryptionAvailable())
        throw new Error('macOS credential encryption is unavailable.');
      return validateConnection(JSON.parse(encryption.decryptString(data)));
    },
    async save(value) {
      const connection = validateConnection(value);
      if (!encryption.isEncryptionAvailable())
        throw new Error('macOS credential encryption is unavailable.');
      const data = encryption.encryptString(JSON.stringify(connection));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, data, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    },
  };
}
