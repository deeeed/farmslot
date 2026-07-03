import type { ArtifactRef } from '../recipes/step-io.js';

export const INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1 = 'farmslot.interactive.operator-packet.v1';

export const INTERACTIVE_OPERATOR_PACKET_INTENTS: readonly [
  'plan',
  'decision',
  'review',
  'blocker',
  'evidence',
  'comparison',
] = ['plan', 'decision', 'review', 'blocker', 'evidence', 'comparison'];

export type InteractiveOperatorPacketIntent = (typeof INTERACTIVE_OPERATOR_PACKET_INTENTS)[number];

export const INTERACTIVE_OPERATOR_PACKET_ACTION_KINDS: readonly [
  'terminal.send',
  'decision.resolve',
  'copy',
  'open-artifact',
] = ['terminal.send', 'decision.resolve', 'copy', 'open-artifact'];

export type InteractiveOperatorPacketActionKind =
  (typeof INTERACTIVE_OPERATOR_PACKET_ACTION_KINDS)[number];

export type InteractiveOperatorPacketActionSafety = 'read-only' | 'operator-confirmed';

export interface InteractiveOperatorPacketBody {
  format: 'markdown';
  path?: string;
  text?: string;
}

export interface InteractiveOperatorPacketAnchor {
  id: string;
  label: string;
  artifactPath?: string;
  selector?: string;
  line?: number;
  range?: { start: number; end: number };
}

export interface InteractiveOperatorPacketAction {
  id: string;
  label: string;
  kind: InteractiveOperatorPacketActionKind;
  safety: InteractiveOperatorPacketActionSafety;
  payload?: Record<string, unknown>;
}

export type InteractiveOperatorPacketActionRequest =
  | { kind: 'copy'; text: string }
  | { kind: 'open-artifact'; artifactPath: string }
  | { kind: 'terminal.send'; text: string }
  | { kind: 'decision.resolve'; decisionId: string; actionId: string };

export interface InteractiveOperatorPacket {
  schema: typeof INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1;
  id: string;
  runId?: string;
  title: string;
  intent: InteractiveOperatorPacketIntent;
  summary?: string;
  body: InteractiveOperatorPacketBody;
  anchors?: InteractiveOperatorPacketAnchor[];
  actions?: InteractiveOperatorPacketAction[];
  createdAt: string;
}

export interface InteractiveOperatorPacketValidationResult {
  ok: boolean;
  packet?: InteractiveOperatorPacket;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return stringValue(value);
}

function hasOnlyKnownValues<T extends string>(value: unknown, known: readonly T[]): value is T {
  if (typeof value !== 'string') return false;
  return known.some((candidate) => candidate === value);
}

function knownStringValue<T extends string>(value: unknown, known: readonly T[]): T | null {
  return hasOnlyKnownValues(value, known) ? value : null;
}

function parseBody(value: unknown, errors: string[]): InteractiveOperatorPacketBody | null {
  if (!isRecord(value)) {
    errors.push('body must be an object');
    return null;
  }
  if (value.format !== 'markdown') {
    errors.push('body.format must be "markdown"');
    return null;
  }
  const path = stringValue(value.path) ?? undefined;
  const text = stringValue(value.text) ?? undefined;
  if (!path && !text) {
    errors.push('body must include path or text');
    return null;
  }
  const body: InteractiveOperatorPacketBody = { format: 'markdown' };
  if (path) body.path = path;
  if (text) body.text = text;
  return body;
}

function parseAnchors(
  value: unknown,
  errors: string[],
): InteractiveOperatorPacketAnchor[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    errors.push('anchors must be an array');
    return undefined;
  }
  const anchors: InteractiveOperatorPacketAnchor[] = [];
  const seenIds = new Set<string>();
  value.forEach((anchor, index) => {
    if (!isRecord(anchor)) {
      errors.push(`anchors[${index}] must be an object`);
      return;
    }
    const id = stringValue(anchor.id);
    const label = stringValue(anchor.label);
    if (!id) errors.push(`anchors[${index}].id must be a non-empty string`);
    if (id && seenIds.has(id)) {
      errors.push(`anchors[${index}].id must be unique`);
    }
    if (!label) {
      errors.push(`anchors[${index}].label must be a non-empty string`);
    }
    const artifactPath = stringValue(anchor.artifactPath) ?? undefined;
    const selector = stringValue(anchor.selector) ?? undefined;
    const line = Number.isInteger(anchor.line) ? Number(anchor.line) : undefined;
    if (anchor.line != null && (line == null || line < 1)) {
      errors.push(`anchors[${index}].line must be a positive integer`);
    }
    let range: { start: number; end: number } | undefined;
    if (anchor.range != null) {
      if (!isRecord(anchor.range)) {
        errors.push(`anchors[${index}].range must be an object`);
      } else if (
        !Number.isInteger(anchor.range.start) ||
        !Number.isInteger(anchor.range.end) ||
        Number(anchor.range.start) < 0 ||
        Number(anchor.range.end) < Number(anchor.range.start)
      ) {
        errors.push(`anchors[${index}].range must include valid start/end offsets`);
      } else {
        range = { start: Number(anchor.range.start), end: Number(anchor.range.end) };
      }
    }
    if (id && label && (anchor.line == null || line != null) && (anchor.range == null || range)) {
      seenIds.add(id);
      const parsed: InteractiveOperatorPacketAnchor = { id, label };
      if (artifactPath) parsed.artifactPath = artifactPath;
      if (selector) parsed.selector = selector;
      if (line != null) parsed.line = line;
      if (range) parsed.range = range;
      anchors.push(parsed);
    }
  });
  return anchors;
}

function parseActions(
  value: unknown,
  errors: string[],
): InteractiveOperatorPacketAction[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    errors.push('actions must be an array');
    return undefined;
  }
  const actions: InteractiveOperatorPacketAction[] = [];
  const seenIds = new Set<string>();
  value.forEach((action, index) => {
    if (!isRecord(action)) {
      errors.push(`actions[${index}] must be an object`);
      return;
    }
    const id = stringValue(action.id);
    const label = stringValue(action.label);
    if (!id) errors.push(`actions[${index}].id must be a non-empty string`);
    if (id && seenIds.has(id)) {
      errors.push(`actions[${index}].id must be unique`);
    }
    if (!label) {
      errors.push(`actions[${index}].label must be a non-empty string`);
    }
    const kind = knownStringValue(action.kind, INTERACTIVE_OPERATOR_PACKET_ACTION_KINDS);
    if (!kind) {
      errors.push(`actions[${index}].kind is unsupported`);
    }
    const safety =
      action.safety === 'read-only' || action.safety === 'operator-confirmed'
        ? action.safety
        : null;
    if (!safety) {
      errors.push(`actions[${index}].safety must be read-only or operator-confirmed`);
    }
    const payload = isRecord(action.payload) ? action.payload : undefined;
    if (action.payload != null && !isRecord(action.payload)) {
      errors.push(`actions[${index}].payload must be an object when present`);
    }
    if (id && label && kind && safety && (action.payload == null || payload)) {
      seenIds.add(id);
      const parsed: InteractiveOperatorPacketAction = { id, label, kind, safety };
      if (payload) parsed.payload = payload;
      actions.push(parsed);
    }
  });
  return actions;
}

export function validateInteractiveOperatorPacket(
  value: unknown,
): InteractiveOperatorPacketValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['packet must be an object'] };
  if (value.schema !== INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1) {
    errors.push(`schema must be ${INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1}`);
  }
  const id = stringValue(value.id);
  const runId = stringValue(value.runId) ?? undefined;
  const title = stringValue(value.title);
  const summary = stringValue(value.summary) ?? undefined;
  const intent = hasOnlyKnownValues(value.intent, INTERACTIVE_OPERATOR_PACKET_INTENTS)
    ? value.intent
    : null;
  const createdAt = stringValue(value.createdAt);
  if (!id) errors.push('id must be a non-empty string');
  if (!title) errors.push('title must be a non-empty string');
  if (!intent) {
    errors.push('intent is unsupported');
  }
  const body = parseBody(value.body, errors);
  const anchors = parseAnchors(value.anchors, errors);
  const actions = parseActions(value.actions, errors);
  if (!createdAt) errors.push('createdAt must be a non-empty string');
  if (errors.length > 0 || !id || !title || !intent || !body || !createdAt) {
    return { ok: false, errors };
  }
  const packet: InteractiveOperatorPacket = {
    schema: INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
    id,
    title,
    intent,
    body,
    createdAt,
  };
  if (runId) packet.runId = runId;
  if (summary) packet.summary = summary;
  if (anchors) packet.anchors = anchors;
  if (actions) packet.actions = actions;
  return { ok: true, packet, errors: [] };
}

export function isInteractiveOperatorPacket(value: unknown): value is InteractiveOperatorPacket {
  return validateInteractiveOperatorPacket(value).ok;
}

export function interactiveOperatorPacketActionRequest(
  action: InteractiveOperatorPacketAction,
): InteractiveOperatorPacketActionRequest | null {
  switch (action.kind) {
    case 'copy': {
      const text = payloadString(action.payload, 'text');
      return text ? { kind: 'copy', text } : null;
    }
    case 'open-artifact': {
      const artifactPath = payloadString(action.payload, 'artifactPath');
      return artifactPath ? { kind: 'open-artifact', artifactPath } : null;
    }
    case 'terminal.send': {
      const text = payloadString(action.payload, 'text');
      return text ? { kind: 'terminal.send', text } : null;
    }
    case 'decision.resolve': {
      const decisionId = payloadString(action.payload, 'decisionId');
      const actionId = payloadString(action.payload, 'actionId');
      return decisionId && actionId ? { kind: 'decision.resolve', decisionId, actionId } : null;
    }
  }
}

export function isInteractiveOperatorPacketArtifact(
  artifact: Pick<ArtifactRef, 'path' | 'purpose' | 'type' | 'mimeType'>,
): boolean {
  const normalizedPath = artifact.path.replace(/\\/g, '/').toLowerCase();
  const purpose = artifact.purpose?.toLowerCase() ?? '';
  const type = artifact.type?.toLowerCase() ?? '';
  const mimeType = artifact.mimeType?.toLowerCase() ?? '';
  return (
    normalizedPath.endsWith('.packet.json') ||
    purpose === 'interactive-packet' ||
    type === 'interactive-packet' ||
    mimeType === 'application/vnd.farmslot.operator-packet+json'
  );
}

export function interactiveOperatorPacketArtifacts<
  T extends Pick<ArtifactRef, 'path' | 'purpose' | 'type' | 'mimeType'>,
>(artifacts: readonly T[]): T[] {
  return artifacts.filter(isInteractiveOperatorPacketArtifact);
}
