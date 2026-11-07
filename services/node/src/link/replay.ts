import { randomUUID } from 'node:crypto';

import {
  NODE_LINK_LIMITS,
  type NodeLinkAuthority,
  type NodeLinkCursor,
  NodeLinkFailure,
  type NodeLinkResumeResult,
  type NodeLinkStreamFrame,
  type NodeLinkTarget,
} from '@farmslot/protocol';

interface RetainedFrame<Payload> {
  frame: NodeLinkStreamFrame<Payload>;
  bytes: number;
}

/** The producer indexes each committed unit once; resume never scans a journal. */
export class NodeLinkReplay<Payload> {
  private readonly frames = new Map<number, RetainedFrame<Payload>>();
  private offset = 0;
  private bytes = 0;
  readonly incarnation = randomUUID();

  constructor(
    readonly streamId: string,
    private readonly target: NodeLinkTarget,
    private readonly authority: NodeLinkAuthority,
    private readonly snapshot: () => Payload,
    private readonly limit = NODE_LINK_LIMITS.streamBytes,
  ) {}

  get retainedBytes(): number {
    return this.bytes;
  }
  get retainedFrames(): number {
    return this.frames.size;
  }
  get cursor(): NodeLinkCursor {
    return { streamId: this.streamId, incarnation: this.incarnation, offset: this.offset };
  }

  append(payload: Payload): NodeLinkStreamFrame<Payload> {
    const frame: NodeLinkStreamFrame<Payload> = {
      ...this.cursor,
      offset: this.offset + 1,
      target: structuredClone(this.target),
      authority: structuredClone(this.authority),
      payload: structuredClone(payload),
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > this.limit)
      throw new NodeLinkFailure('FRAME_TOO_LARGE', 'Stream unit requires bounded producer chunks.');
    this.offset++;
    this.frames.set(this.offset, { frame, bytes });
    this.bytes += bytes;
    while (this.bytes > this.limit) {
      const first = this.frames.keys().next().value;
      if (first === undefined) break;
      const removed = this.frames.get(first);
      if (!removed) throw new Error('Missing indexed stream frame');
      this.frames.delete(first);
      this.bytes -= removed.bytes;
    }
    return structuredClone(frame);
  }

  resume(cursor: NodeLinkCursor): NodeLinkResumeResult<Payload> {
    if (cursor.streamId !== this.streamId || cursor.incarnation !== this.incarnation)
      return this.reset('source-replaced');
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > this.offset)
      throw new NodeLinkFailure('INVALID_CURSOR', 'Stream cursor is outside the source range.');
    if (cursor.offset === this.offset) return { kind: 'replay', frames: [], cursor: this.cursor };
    const first = this.frames.keys().next().value;
    if (first === undefined || cursor.offset < first - 1) return this.reset('expired');
    const frames: NodeLinkStreamFrame<Payload>[] = [];
    for (let offset = cursor.offset + 1; offset <= this.offset; offset++) {
      const retained = this.frames.get(offset);
      if (!retained) return this.reset('gap');
      frames.push(structuredClone(retained.frame));
    }
    return { kind: 'replay', frames, cursor: this.cursor };
  }

  private reset(reason: 'expired' | 'gap' | 'source-replaced'): NodeLinkResumeResult<Payload> {
    const reset = {
      kind: 'reset' as const,
      reason,
      snapshot: structuredClone(this.snapshot()),
      cursor: this.cursor,
    };
    if (Buffer.byteLength(JSON.stringify(reset)) > NODE_LINK_LIMITS.frameBytes)
      throw new NodeLinkFailure(
        'SNAPSHOT_TOO_LARGE',
        'Source cannot supply a bounded resynchronization snapshot.',
      );
    return reset;
  }
}

/** Advance only contiguous applied frames. A duplicate never advances credit. */
export function appliedNodeLinkCursor(
  cursor: NodeLinkCursor,
  frame: NodeLinkCursor,
): NodeLinkCursor {
  if (cursor.streamId !== frame.streamId || cursor.incarnation !== frame.incarnation)
    throw new NodeLinkFailure(
      'SOURCE_REPLACED',
      'Replace the projection from an authorized snapshot.',
    );
  if (frame.offset <= cursor.offset) return cursor;
  if (frame.offset !== cursor.offset + 1)
    throw new NodeLinkFailure('STREAM_GAP', 'Resume from the last contiguous applied offset.');
  return { ...frame };
}
