import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type ConfiguredExecutionTemplateSource,
  isRecord,
  type UnavailableExecutionTemplateSource,
} from '@farmslot/protocol';

import type { ExecutionTemplateSource } from './types.js';

export const EXECUTION_TEMPLATE_CATALOG_DIR = '.execution-template-catalog';
export const EXECUTION_TEMPLATE_CATALOG_FILE = `${EXECUTION_TEMPLATE_CATALOG_DIR}.json`;

interface AvailableCatalogSource {
  declaration: ConfiguredExecutionTemplateSource;
  relativeRoot: string;
  sourceRevision?: string;
  sourceDirty?: boolean;
}
interface UnavailableCatalogSource {
  declaration: ConfiguredExecutionTemplateSource;
  unavailableReason: UnavailableExecutionTemplateSource['reason'];
}
export type ExecutionTemplateCatalogSourceSnapshot =
  | AvailableCatalogSource
  | UnavailableCatalogSource;
export interface ExecutionTemplateCatalogSnapshot {
  version: 1;
  sources: ExecutionTemplateCatalogSourceSnapshot[];
}

interface ParsedCatalogSource {
  declaration: Record<string, unknown>;
  root?: string;
  unavailableReason?: UnavailableExecutionTemplateSource['reason'];
  sourceRevision?: string;
  sourceDirty?: boolean;
}
interface BundledCatalog {
  sources: Map<string, ParsedCatalogSource>;
}

function invalid(message: string): never {
  throw Object.assign(new Error(`Invalid bundled execution-template catalog: ${message}`), {
    code: 'TASK_TEMPLATE_CATALOG_INVALID',
  });
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function unavailableReason(value: unknown): value is UnavailableExecutionTemplateSource['reason'] {
  return value === 'missing-environment' || value === 'missing-root' || value === 'invalid-root';
}

/** Only runtime-selected support supplies this descriptor; task JSON never selects a root. */
export function readBundledExecutionTemplateCatalog(root: string): BundledCatalog | undefined {
  const file = path.join(root, EXECUTION_TEMPLATE_CATALOG_FILE);
  if (!existsSync(file)) return;
  const canonical = realpathSync(root);
  if (!within(canonical, realpathSync(file))) invalid('descriptor escapes its support project');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    invalid('descriptor is not JSON');
  }
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.sources))
    invalid('unsupported descriptor');
  const sources = new Map<string, ParsedCatalogSource>();
  for (const row of data.sources) {
    if (!isRecord(row) || !isRecord(row.declaration)) invalid('missing source declaration');
    const declaration = row.declaration;
    if (
      typeof declaration.id !== 'string' ||
      !declaration.id ||
      typeof declaration.kind !== 'string' ||
      !isRecord(declaration.root) ||
      typeof declaration.root.env !== 'string' ||
      (declaration.subpath !== undefined && typeof declaration.subpath !== 'string') ||
      (declaration.domains !== undefined &&
        (!Array.isArray(declaration.domains) ||
          !declaration.domains.every((domain) => typeof domain === 'string')))
    )
      invalid('malformed source declaration');
    if (sources.has(declaration.id)) invalid(`duplicate source ${declaration.id}`);
    if (row.unavailableReason !== undefined) {
      if (!unavailableReason(row.unavailableReason) || row.relativeRoot !== undefined)
        invalid(`ambiguous source ${declaration.id}`);
      sources.set(declaration.id, { declaration, unavailableReason: row.unavailableReason });
      continue;
    }
    if (
      typeof row.relativeRoot !== 'string' ||
      !row.relativeRoot.startsWith(`${EXECUTION_TEMPLATE_CATALOG_DIR}/`) ||
      row.relativeRoot.split(/[\\/]/).includes('..') ||
      path.isAbsolute(row.relativeRoot) ||
      (row.sourceRevision !== undefined && typeof row.sourceRevision !== 'string') ||
      (row.sourceDirty !== undefined && typeof row.sourceDirty !== 'boolean')
    )
      invalid(`malformed root or provenance for ${declaration.id}`);
    const target = path.resolve(canonical, row.relativeRoot);
    if (
      !existsSync(target) ||
      !statSync(target).isDirectory() ||
      !within(canonical, realpathSync(target))
    )
      invalid(`missing or escaping root for ${declaration.id}`);
    sources.set(declaration.id, {
      declaration,
      root: realpathSync(target),
      ...(row.sourceRevision === undefined ? {} : { sourceRevision: row.sourceRevision }),
      ...(row.sourceDirty === undefined ? {} : { sourceDirty: row.sourceDirty }),
    });
  }
  return { sources };
}

function normalizedDeclaration(value: Record<string, unknown>): unknown {
  return {
    ...Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
    domains: Array.isArray(value.domains) ? [...value.domains].sort() : [],
    subpath: typeof value.subpath === 'string' ? path.posix.normalize(value.subpath) : '.',
  };
}

export function bundledExecutionTemplateSource(
  declaration: ConfiguredExecutionTemplateSource,
  catalog: BundledCatalog,
): ExecutionTemplateSource | UnavailableExecutionTemplateSource {
  const row = catalog.sources.get(declaration.id);
  if (!row) return { id: declaration.id, reason: 'missing-root' };
  if (
    !isDeepStrictEqual(
      normalizedDeclaration({ ...declaration }),
      normalizedDeclaration(row.declaration),
    )
  )
    invalid(`source declaration differs from node configuration: ${declaration.id}`);
  if (row.unavailableReason) return { id: declaration.id, reason: row.unavailableReason };
  if (!row.root) invalid(`missing root for ${declaration.id}`);
  return {
    id: declaration.id,
    kind: declaration.kind,
    root: row.root,
    layout: 'flow-tree',
    ...(declaration.domains ? { domains: declaration.domains } : {}),
    ...(row.sourceRevision === undefined ? {} : { sourceRevision: row.sourceRevision }),
    ...(row.sourceDirty === undefined ? {} : { sourceDirty: row.sourceDirty }),
  };
}
