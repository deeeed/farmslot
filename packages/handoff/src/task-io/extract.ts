import type { SourceDocument, SourceKind } from '../spec/types.js';
import { SCHEMA_VERSION } from '../spec/version.js';

/** The normalized work fields extraction may populate (spec section 3.2). */
type NormalizedField =
  | 'title'
  | 'description'
  | 'acceptanceCriteria'
  | 'labels'
  | 'ticket'
  | 'status'
  | 'priority';

/**
 * A raw task-source blob plus its kind. `raw` is whatever the caller fetched
 * (parsed issue/PR/ticket JSON, or plain fields for text sources); extraction
 * never fetches anything itself.
 */
export interface RawTaskSource {
  sourceKind: SourceKind;
  raw: Record<string, unknown>;
  /** Non-secret pointer to the origin (URL or path key). */
  sourceRef?: string;
}

/**
 * Tool-specific extraction config - an override FILE's parsed content, never a
 * package default. `fieldMap` maps normalized field -> dot-path into `raw`.
 * `extensionFields` opt specific raw paths back in via `extensions{}` (farm
 * config MUST NOT map person fields - the drop-by-default floor is the contract).
 */
export interface TaskIoConfig {
  fieldMap?: Partial<Record<NormalizedField, string>>;
  extensionFields?: Record<string, string>;
}

/** Zero-config field maps for the generic source kinds. Jira ships NO default -
 * it is opt-in via a resolved `task-io.config.json` (design section 2). */
const DEFAULT_FIELD_MAPS: Partial<Record<SourceKind, Partial<Record<NormalizedField, string>>>> = {
  text: {
    title: 'title',
    description: 'description',
    acceptanceCriteria: 'acceptanceCriteria',
    labels: 'labels',
    ticket: 'ticket',
  },
  file: {
    title: 'title',
    description: 'description',
    acceptanceCriteria: 'acceptanceCriteria',
    labels: 'labels',
    ticket: 'ticket',
  },
  'github-issue': {
    title: 'title',
    description: 'body',
    labels: 'labels',
    status: 'state',
  },
  'github-pr': {
    title: 'title',
    description: 'body',
    labels: 'labels',
    status: 'state',
  },
};

function getPath(raw: unknown, dotPath: string): unknown {
  let current: unknown = raw;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Flatten a rich-text-ish value (e.g. nested content nodes) to plain text. */
function textify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(textify).filter((p): p is string => p !== undefined && p !== '');
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.text === 'string') return node.text;
  if (node.content !== undefined) return textify(node.content);
  return undefined;
}

function toLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item !== null && typeof item === 'object') {
        const name = (item as Record<string, unknown>).name;
        return typeof name === 'string' ? name : undefined;
      }
      return undefined;
    })
    .filter((l): l is string => l !== undefined);
  return labels.length > 0 ? labels : undefined;
}

/**
 * Normalize a raw task source into the spec section 3.2 `source.json` shape:
 * content about the WORK only. Extraction is allowlist-only - the ONLY fields
 * that survive are the mapped work fields plus explicitly opted-in extension
 * paths, so reporter/assignee/commenter identity and comment threads are dropped
 * by construction (the PII floor), not by a person-field denylist.
 *
 * Jira has no shipped default map: pass a resolved `task-io.config.json` fieldMap.
 */
export function extractTaskDocument(
  source: RawTaskSource,
  config: TaskIoConfig = {},
): SourceDocument {
  const defaults = DEFAULT_FIELD_MAPS[source.sourceKind];
  const fieldMap = { ...defaults, ...config.fieldMap };
  if (Object.keys(fieldMap).length === 0) {
    throw new Error(
      `extractTaskDocument: no field map for sourceKind '${source.sourceKind}' - this kind ` +
        'is opt-in and ships no package default. Next: provide config.fieldMap (resolve it ' +
        'from a personal or farm task-io.config.json).',
    );
  }

  const document: SourceDocument = { schemaVersion: SCHEMA_VERSION, sourceKind: source.sourceKind };

  const title = textify(getPath(source.raw, fieldMap.title ?? 'title'));
  if (title !== undefined) document.title = title;
  if (fieldMap.description) {
    const description = textify(getPath(source.raw, fieldMap.description));
    if (description !== undefined) document.description = description;
  }
  if (fieldMap.acceptanceCriteria) {
    const ac = textify(getPath(source.raw, fieldMap.acceptanceCriteria));
    if (ac !== undefined) document.acceptanceCriteria = ac;
  }
  if (fieldMap.labels) {
    const labels = toLabels(getPath(source.raw, fieldMap.labels));
    if (labels !== undefined) document.labels = labels;
  }
  for (const field of ['ticket', 'status', 'priority'] as const) {
    const dotPath = fieldMap[field];
    if (!dotPath) continue;
    const value = textify(getPath(source.raw, dotPath));
    if (value !== undefined) document[field] = value;
  }
  if (source.sourceRef !== undefined) document.sourceRef = source.sourceRef;

  if (config.extensionFields) {
    const extensions: Record<string, unknown> = {};
    for (const [key, dotPath] of Object.entries(config.extensionFields)) {
      const value = getPath(source.raw, dotPath);
      if (value !== undefined) extensions[key] = value;
    }
    if (Object.keys(extensions).length > 0) document.extensions = extensions;
  }

  return document;
}
