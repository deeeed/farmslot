import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  NodeLinkFailure,
  type NodeLinkOperationRequest,
  type NodeLinkReceipt,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { invokeNodeLink, type NodeLinkInvocation, reconcileNodeLinkIntent } from './node-link.js';

const attempts = new Map<string, Promise<void>>();

/** A new copy is a new effect, even if its bytes match an earlier copy. Never skip an unknown predecessor. */
export async function invokeNodeLinkAttempt(
  request: NodeLinkOperationRequest,
  invocation: NodeLinkInvocation,
): Promise<NodeLinkReceipt> {
  const file = path.join(
    farmslotHome(),
    'node-link-attempts',
    encodeURIComponent(invocation.target.nodeId),
    createHash('sha256').update(invocation.commandId).digest('hex') + '.json',
  );
  const previous = attempts.get(file) ?? Promise.resolve();
  const operation = previous.then(async () => {
    await invocation.assertCurrent();
    try {
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('commandId' in saved) ||
        typeof saved.commandId !== 'string'
      )
        throw new NodeLinkFailure(
          'INTENT_CORRUPT',
          'Task attempt reference requires reconciliation.',
        );
      await reconcileNodeLinkIntent(invocation.target.nodeId, saved.commandId);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await invocation.assertCurrent();
    const commandId = randomUUID();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${commandId}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ commandId }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const receipt = await invokeNodeLink(request, { ...invocation, commandId });
    if (receipt.closeoutConfirmed) {
      await unlink(file);
      const committed = await open(path.dirname(file), 'r');
      try {
        await committed.sync();
      } finally {
        await committed.close();
      }
    }
    return receipt;
  });
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  attempts.set(file, settled);
  try {
    return await operation;
  } finally {
    if (attempts.get(file) === settled) attempts.delete(file);
  }
}
