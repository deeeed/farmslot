import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { durableWrite, privateDirectory, readJson } from '@farmslot/agent-runtime/native/storage';
import type { NativeExecutionNodeDeclaration } from '@farmslot/protocol';

import { nativeSessionManager } from './manager.js';

function directory(root: string) {
  privateDirectory(root);
  const path = join(root, 'execution-nodes');
  privateDirectory(path);
  return path;
}

/** Remember authenticated declarations so disconnects and gateway restarts do not erase inventory. */
export function rememberNativeExecutionNode(
  machine: string,
  declaration: NativeExecutionNodeDeclaration,
  root = nativeSessionManager.root,
): void {
  durableWrite(join(directory(root), `${encodeURIComponent(machine)}.json`), {
    machine,
    ownerPrincipalId: declaration.ownerPrincipalId,
  });
}

export function knownNativeExecutionNodes(
  owner: string,
  root = nativeSessionManager.root,
): string[] {
  const path = directory(root);
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const record = readJson<{ machine: string; ownerPrincipalId: string }>(join(path, name));
      if (
        typeof record.machine !== 'string' ||
        !record.machine ||
        record.machine === 'local' ||
        typeof record.ownerPrincipalId !== 'string' ||
        !record.ownerPrincipalId
      )
        throw new Error('Native execution node registry has an invalid declaration');
      return record.ownerPrincipalId === owner ? [record.machine] : [];
    });
}
