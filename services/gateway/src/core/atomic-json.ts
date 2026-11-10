import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { assertStorageVolumePresent } from './storage-volume.js';

export async function writeAtomicJSON(file: string, data: unknown): Promise<void> {
  await writeAtomicText(file, JSON.stringify(data));
}

/** Atomically replace a file with text a caller already serialized, such as a store's JSON. */
export async function writeAtomicText(file: string, text: string): Promise<void> {
  assertStorageVolumePresent(file);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
