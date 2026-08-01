// methods/dispatch/slot-file-write.ts — Write text files into local or remote slot workspaces.

import path from 'node:path';

import { type loadSlotVars, slotWriteFiles } from '../../core/index.js';

export async function writeTextFileOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  relativePath: string,
  content: string,
): Promise<void> {
  const targetPath = `${vars.remoteRepo}/${relativePath}`;
  const parentDir = path.dirname(targetPath);
  await slotWriteFiles(vars, parentDir, [
    {
      path: path.basename(targetPath),
      content: Buffer.from(content, 'utf-8').toString('base64'),
    },
  ]);
}
