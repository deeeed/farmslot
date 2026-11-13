// clip.ts — clip.push / clip.list: the farm's last copy-ready snippets, shared by its admins.
import { randomUUID } from 'node:crypto';

import {
  type Clip,
  CLIP_HISTORY_LIMIT,
  CLIP_LABEL_MAX_LENGTH,
  CLIP_SOURCE_MAX_LENGTH,
  CLIP_TEXT_MAX_BYTES,
  clipLinkUrl,
  type ClipListResult,
  type ClipPushResult,
  type Principal,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { redactLogContent } from '../observability/log-registry.js';
import { resourceRevisions } from '../resources/revisions.js';

// One farm list: lanes push under a service principal while the operator reads as a person.
// In memory only: clips are a short-lived copy buffer and are gone after a gateway restart.
let clips: Clip[] = [];

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new GatewayMethodError('INVALID_PARAMS', `${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max)
    throw new GatewayMethodError('INVALID_PARAMS', `${name} is longer than ${max} characters`);
  return trimmed || undefined;
}

export function clipPush(principal: Principal, params: unknown): ClipPushResult {
  const input = (params ?? {}) as Record<string, unknown>;
  const kind = input.kind ?? 'text';
  if (kind !== 'text' && kind !== 'link')
    throw new GatewayMethodError('INVALID_PARAMS', "kind must be 'text' or 'link'");
  if (typeof input.text !== 'string' || !input.text.trim())
    throw new GatewayMethodError('INVALID_PARAMS', 'text is required');
  const bytes = Buffer.byteLength(input.text, 'utf8');
  if (bytes > CLIP_TEXT_MAX_BYTES)
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      `Clip text is ${bytes} bytes; the limit is ${CLIP_TEXT_MAX_BYTES}`,
    );
  if (kind === 'link' && !clipLinkUrl(input.text))
    throw new GatewayMethodError('INVALID_PARAMS', 'A link clip must be one http(s) URL');
  const label = optionalText(input.label, 'label', CLIP_LABEL_MAX_LENGTH);
  const source = optionalText(input.source, 'source', CLIP_SOURCE_MAX_LENGTH);
  const text = redactLogContent(kind === 'link' ? input.text.trim() : input.text);
  // Redaction markers can be longer than what they replace, so the stored text is checked too.
  const storedBytes = Buffer.byteLength(text, 'utf8');
  if (storedBytes > CLIP_TEXT_MAX_BYTES)
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      `Clip text is ${storedBytes} bytes after redaction; the limit is ${CLIP_TEXT_MAX_BYTES}`,
    );
  const clip: Clip = {
    id: randomUUID(),
    kind,
    text,
    ...(label ? { label: redactLogContent(label) } : {}),
    principalId: principal.id,
    ...(source ? { source } : {}),
    createdAt: new Date().toISOString(),
  };
  clips = [clip, ...clips].slice(0, CLIP_HISTORY_LIMIT);
  resourceRevisions.advance({ family: 'clipboard', scope: 'farm' });
  return { clip };
}

/** Newest first. */
export function clipList(): ClipListResult {
  return { clips: [...clips] };
}

export function clearClipsForTests(): void {
  clips = [];
}
