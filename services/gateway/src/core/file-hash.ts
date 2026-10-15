import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { digestFileWithinRoot } from '@farmslot/recipe-runner';

export async function sha256File(filePath: string): Promise<string> {
  const file = await realpath(filePath);
  return (await digestFileWithinRoot(path.dirname(file), path.basename(file))).slice(7);
}
