import { createHash, type Hash } from 'node:crypto';

import { acpObject, acpString } from './acp-rpc.js';
import type { NativeEventInput } from './types.js';

interface MspItem {
  turnId: string;
  revision: number;
  length: number;
  digest: Hash;
  finished: boolean;
}

/** Muse/MSP text contract at the pinned reference revision. This decoder alone does
 * not advertise an installed runner, launch/auth support, or completed runtime parity.
 */
export class MspTextStream {
  private items = new Map<string, MspItem>();
  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly commandId: string,
    private readonly emit: (event: NativeEventInput) => void,
  ) {}

  accept(sessionId: string, method: string, value: unknown): void {
    if (sessionId !== this.sessionId) return;
    const params = acpObject(value);
    if (['item/started', 'item/updated', 'item/completed'].includes(method)) {
      const item = acpObject(params.item);
      if (item.kind !== 'agentMessage' || item.turnId !== this.turnId) return;
      const id = acpString(item.itemId);
      if (
        typeof item.revision !== 'number' ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      )
        throw new Error('Invalid MSP item revision');
      const previous = this.items.get(id);
      if (previous && (previous.revision >= item.revision || previous.finished)) return;
      const text = item.text === undefined ? undefined : acpString(item.text);
      if (
        previous &&
        text !== undefined &&
        (text.length < previous.length ||
          createHash('sha256').update(text.slice(0, previous.length)).digest('hex') !==
            previous.digest.copy().digest('hex'))
      )
        throw new Error('MSP item rewrote committed text');
      if (!previous && this.items.size >= 128) throw new Error('MSP text item budget exhausted');
      const delta = text?.slice(previous?.length ?? 0) ?? '';
      const digest = previous?.digest ?? createHash('sha256');
      digest.update(delta);
      this.items.set(id, {
        turnId: this.turnId,
        revision: item.revision,
        length: text?.length ?? previous?.length ?? 0,
        digest,
        finished: item.status !== 'inProgress',
      });
      if (delta) this.emit({ type: 'text.delta', commandId: this.commandId, text: delta });
      return;
    }
    if (method !== 'item/delta' || (params.field !== undefined && params.field !== 'text')) return;
    const item = this.items.get(acpString(params.itemId));
    if (!item || item.finished) return;
    const delta = acpString(params.delta);
    item.length += delta.length;
    item.digest.update(delta);
    if (delta) this.emit({ type: 'text.delta', commandId: this.commandId, text: delta });
  }
}
