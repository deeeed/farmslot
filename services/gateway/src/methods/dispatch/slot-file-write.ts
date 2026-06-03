// methods/dispatch/slot-file-write.ts — Write text files into local or remote slot workspaces.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execOnSlot, isLocal, type loadSlotVars } from '../../core/index.js';

export async function writeTextFileOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  relativePath: string,
  content: string,
): Promise<void> {
  const targetPath = `${vars.remoteRepo}/${relativePath}`;
  const parentDir = path.dirname(targetPath);

  if (isLocal(vars.host, vars.machine)) {
    await mkdir(parentDir, { recursive: true });
    await writeFile(targetPath, content, 'utf-8');
    return;
  }

  // Remote fallback uses python3 for lossless base64 writes. Our managed Linux/macOS
  // nodes already depend on python3 for automation, and this avoids complex shell
  // escaping for arbitrarily large text payloads.
  const payload = Buffer.from(content, 'utf-8').toString('base64');
  const remoteScript = [
    "python3 - <<'PY'",
    'from pathlib import Path',
    'import base64',
    `target = Path(${JSON.stringify(targetPath)})`,
    `target.parent.mkdir(parents=True, exist_ok=True)`,
    `target.write_bytes(base64.b64decode(${JSON.stringify(payload)}))`,
    'PY',
  ].join('\n');
  await execOnSlot(vars, remoteScript);
}
