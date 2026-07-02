import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readCatalogFlows } from './flows.js';
import { isRecord, readJsonFile, writeJsonFile } from './json.js';
import type { RecipeLogger } from './types.js';

const LIBRARY_MANIFEST_FILE = 'library.json';
const LIBRARY_FLOWS_DIR = 'flows';

export interface PromoteFlowRequest {
  /** Per-change recipe declaring the flow inline under `flows`. */
  recipePath: string;
  /** Flow ref to promote. */
  flowRef: string;
  /** Target library root; a library skeleton is created when missing. */
  targetRoot: string;
  /** Target library name, used when creating the skeleton and in messages. */
  targetName: string;
  /** Catalog file stem override; defaults to the ref minus its last segment. */
  domain?: string;
  /**
   * Artifacts directory of a passing run that exercised the flow. Stamps
   * `provenance.lastVerified` from its summary.json; without it the promoted
   * flow carries no verification claim.
   */
  runArtifactsDir?: string;
  /** Overwrite an existing declaration of the same ref in the target library. */
  force?: boolean;
  logger?: RecipeLogger;
}

export interface PromoteFlowResult {
  ref: string;
  /** Absolute catalog file path the flow was written to. */
  catalogPath: string;
  /** True when the library skeleton (library.json + flows/) was created. */
  createdLibrary: boolean;
  lastVerified?: string;
}

/**
 * Promote an inline flow from a per-change recipe into a recipe library.
 * Per ADR-style recipe semantics the recipe itself stays throwaway; promote is
 * the explicit "keep" step that turns a proven setup flow into a durable,
 * contract-checked library entry. Promotion enforces the flow-catalog
 * contract: a description is required, `ensure_*` flows must declare a
 * postcondition, and provenance (origin recipe, promotion date, optional
 * last-verified evidence) is stamped onto the stored flow.
 */
export async function promoteRecipeFlow(request: PromoteFlowRequest): Promise<PromoteFlowResult> {
  const recipePath = path.resolve(request.recipePath);
  const recipe = await readJsonFile(recipePath);
  if (!isRecord(recipe)) throw new Error(`${request.recipePath} is not a recipe document.`);
  const inlineFlows = isRecord(recipe.flows) ? recipe.flows : {};
  const flow = inlineFlows[request.flowRef];
  if (!isRecord(flow)) {
    const available = Object.keys(inlineFlows);
    throw new Error(
      `Flow ${request.flowRef} is not declared inline in ${request.recipePath}. Promote extracts inline flows from per-change recipes${
        available.length > 0 ? `; available: ${available.join(', ')}` : ''
      }.`,
    );
  }

  assertPromotableFlow(request.flowRef, flow, request.logger);
  const lastVerified = request.runArtifactsDir
    ? await readVerifiedRunDate(request.runArtifactsDir)
    : undefined;

  const targetRoot = path.resolve(request.targetRoot);
  const createdLibrary = await ensureLibrarySkeleton(targetRoot, request.targetName);

  const stem = request.domain ?? domainStem(request.flowRef);
  const catalogPath = path.join(targetRoot, LIBRARY_FLOWS_DIR, `${stem}.flows.json`);
  const catalog = await readCatalog(catalogPath);
  if (isRecord(catalog.flows) && catalog.flows[request.flowRef] != null && !request.force) {
    throw new Error(
      `Flow ${request.flowRef} already exists in ${catalogPath}. Edit the catalog directly or pass --force to overwrite.`,
    );
  }

  const promoted: Record<string, unknown> = {
    ...flow,
    version: typeof flow.version === 'number' ? flow.version : 1,
    provenance: {
      promotedFrom: {
        recipe: typeof recipe.title === 'string' ? recipe.title : path.basename(recipePath),
      },
      promotedAt: isoDate(new Date()),
      ...(lastVerified ? { lastVerified: { date: lastVerified } } : {}),
    },
  };
  catalog.flows = {
    ...(isRecord(catalog.flows) ? catalog.flows : {}),
    [request.flowRef]: promoted,
  };
  await writeJsonFile(catalogPath, catalog);

  return {
    ref: request.flowRef,
    catalogPath,
    createdLibrary,
    ...(lastVerified ? { lastVerified } : {}),
  };
}

function assertPromotableFlow(
  ref: string,
  flow: Record<string, unknown>,
  logger?: RecipeLogger,
): void {
  // Reuse catalog normalization so promotion fails on the same shapes a
  // library load would reject.
  readCatalogFlows({ flows: { [ref]: flow } }, 'promote');
  if (typeof flow.description !== 'string' || !flow.description.trim()) {
    throw new Error(
      `Flow ${ref} needs a description before promotion — library flows are agent-facing contracts.`,
    );
  }
  const localName = ref.split('.').at(-1) ?? ref;
  if (localName.startsWith('ensure_') && flow.postcondition == null) {
    throw new Error(
      `Flow ${ref} is an ensure_* flow and must declare a postcondition proving convergence before promotion.`,
    );
  }
  if (flow.paramsSchema == null) {
    logger?.warn(
      `Flow ${ref} has no paramsSchema; add one so agents can discover valid parameters.`,
    );
  }
  if (flow.postcondition == null) {
    logger?.warn(
      `Flow ${ref} has no postcondition; stale library flows fail loudly only when they assert their outcome.`,
    );
  }
}

async function readVerifiedRunDate(artifactsDir: string): Promise<string> {
  const summaryPath = path.join(path.resolve(artifactsDir), 'summary.json');
  const summary = await readJsonFile(summaryPath);
  if (!isRecord(summary)) throw new Error(`${summaryPath} is not a run summary.`);
  if (summary.status !== 'pass') {
    throw new Error(
      `Run summary ${summaryPath} has status ${String(summary.status)}; only passing runs can stamp lastVerified.`,
    );
  }
  const endedAt = typeof summary.endedAt === 'string' ? Date.parse(summary.endedAt) : Number.NaN;
  return isoDate(Number.isNaN(endedAt) ? new Date() : new Date(endedAt));
}

async function ensureLibrarySkeleton(targetRoot: string, name: string): Promise<boolean> {
  const manifestPath = path.join(targetRoot, LIBRARY_MANIFEST_FILE);
  let manifestText: string | undefined;
  try {
    manifestText = await readFile(manifestPath, 'utf-8');
  } catch {
    manifestText = undefined;
  }
  if (manifestText === undefined) {
    await mkdir(path.join(targetRoot, LIBRARY_FLOWS_DIR), { recursive: true });
    await writeJsonFile(manifestPath, { kind: 'recipe-library', schema_version: 1, name });
    return true;
  }
  const manifest: unknown = JSON.parse(manifestText);
  if (!isRecord(manifest) || manifest.kind !== 'recipe-library') {
    throw new Error(`${manifestPath} must declare kind "recipe-library".`);
  }
  await mkdir(path.join(targetRoot, LIBRARY_FLOWS_DIR), { recursive: true });
  return false;
}

async function readCatalog(catalogPath: string): Promise<Record<string, unknown>> {
  let catalog: unknown;
  try {
    catalog = await readJsonFile(catalogPath);
  } catch {
    return { schema_version: 1, kind: 'recipe-flow-catalog', flows: {} };
  }
  if (!isRecord(catalog) || catalog.kind !== 'recipe-flow-catalog') {
    throw new Error(`${catalogPath} must declare kind "recipe-flow-catalog".`);
  }
  return { ...catalog };
}

function domainStem(ref: string): string {
  const segments = ref.split('.').filter(Boolean);
  return segments.length > 1 ? segments.slice(0, -1).join('.') : 'main';
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
