import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A JSON Schema node from the shipped spec assets. The validator interprets the
 * bounded keyword set the format uses; this type keeps the shape open.
 */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  minimum?: number;
  minItems?: number;
  maxItems?: number;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  examples?: unknown[];
}

/** The spec's JSON-file schemas keyed by the package-relative file they govern. */
export type SchemaName =
  | 'manifest'
  | 'source'
  | 'provenance'
  | 'artifacts-index'
  | 'scrub-report'
  | 'pr-publication'
  | 'index-row'
  | 'grade';

const SCHEMA_FILES: Record<SchemaName, string> = {
  manifest: 'manifest.schema.json',
  source: 'source.schema.json',
  provenance: 'provenance.schema.json',
  'artifacts-index': 'artifacts-index.schema.json',
  'scrub-report': 'scrub-report.schema.json',
  'pr-publication': 'pr-publication.schema.json',
  'index-row': 'index-row.schema.json',
  grade: 'grade.schema.json',
};

/**
 * The `schemas/` asset dir sits beside both `src/` (tsx test runs) and `dist/`
 * (published/built runs) at the package root, so this relative resolution is
 * identical in either location.
 */
const schemasDir = fileURLToPath(new URL('../../schemas/', import.meta.url));

const cache = new Map<SchemaName, JsonSchema>();

/** Load one shipped spec schema by name. */
export function loadSchema(name: SchemaName): JsonSchema {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = readFileSync(schemasDir + SCHEMA_FILES[name], 'utf8');
  const parsed = JSON.parse(raw) as JsonSchema;
  cache.set(name, parsed);
  return parsed;
}

/** Load every shipped spec schema. */
export function loadAllSchemas(): Record<SchemaName, JsonSchema> {
  const all = {} as Record<SchemaName, JsonSchema>;
  for (const name of Object.keys(SCHEMA_FILES) as SchemaName[]) {
    all[name] = loadSchema(name);
  }
  return all;
}

export const SCHEMA_NAMES = Object.keys(SCHEMA_FILES) as SchemaName[];
