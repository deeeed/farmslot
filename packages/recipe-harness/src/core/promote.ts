import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readCatalogFlows } from './flows.js';
import { isRecord, readJsonFile, writeJsonFile } from './json.js';
import { listFlowCatalogFiles } from './library.js';
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
    ? await readVerifiedRunDate(request.runArtifactsDir, request.flowRef, flow)
    : undefined;

  const targetRoot = path.resolve(request.targetRoot);
  const createdLibrary = await ensureLibrarySkeleton(targetRoot, request.targetName);

  // The whole library is checked, not just the target catalog file: one
  // library must never declare the same ref twice, or every later resolution
  // of it fails. With --force the flow is overwritten in the file that
  // already declares it, never written to a second one.
  const declaringCatalogs = await findFlowDeclarations(targetRoot, request.flowRef);
  if (declaringCatalogs.length > 1) {
    // Pre-existing corruption: promote cannot pick which declaration is the
    // stale one, and overwriting only one of them would leave the library
    // unloadable. Fail loudly with every offending file, --force or not.
    throw new Error(
      `Recipe library ${targetRoot} already declares ${request.flowRef} in ${declaringCatalogs.length} catalogs (${declaringCatalogs
        .map((file) => path.basename(file))
        .join(
          ', ',
        )}); the library cannot load until exactly one declaration remains. Remove the stale duplicate(s), then re-run promote.`,
    );
  }
  const existingCatalogPath = declaringCatalogs[0];
  if (existingCatalogPath && !request.force) {
    throw new Error(
      `Flow ${request.flowRef} already exists in ${existingCatalogPath}. Edit the catalog directly or pass --force to overwrite it in place.`,
    );
  }
  const stem = request.domain ?? domainStem(request.flowRef);
  const catalogPath =
    existingCatalogPath ?? path.join(targetRoot, LIBRARY_FLOWS_DIR, `${stem}.flows.json`);
  if (
    existingCatalogPath &&
    request.domain &&
    path.basename(existingCatalogPath) !== `${request.domain}.flows.json`
  ) {
    request.logger?.warn(
      `Flow ${request.flowRef} already lives in ${path.basename(existingCatalogPath)}; --domain ${request.domain} is ignored to avoid declaring the ref twice.`,
    );
  }
  const catalog = await readCatalog(catalogPath);

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

async function readVerifiedRunDate(
  artifactsDir: string,
  flowRef: string,
  flow: Record<string, unknown>,
): Promise<string> {
  const resolvedDir = path.resolve(artifactsDir);
  const summaryPath = path.join(resolvedDir, 'summary.json');
  const summary = await readJsonFile(summaryPath);
  if (!isRecord(summary)) throw new Error(`${summaryPath} is not a run summary.`);
  if (summary.status !== 'pass') {
    throw new Error(
      `Run summary ${summaryPath} has status ${String(summary.status)}; only passing runs can stamp lastVerified.`,
    );
  }
  const endedAt = typeof summary.endedAt === 'string' ? Date.parse(summary.endedAt) : Number.NaN;
  if (Number.isNaN(endedAt)) {
    throw new Error(
      `Run summary ${summaryPath} has no parseable endedAt; refusing to stamp lastVerified from incomplete evidence.`,
    );
  }
  await assertRunExercisedFlow(resolvedDir, summary, flowRef, flow);
  return isoDate(new Date(endedAt));
}

/**
 * lastVerified is a claim reviewers rely on, so it must be backed by evidence
 * the run actually executed this flow — a bare passing summary is not enough.
 * Accepted evidence: the run resolved the ref from a library
 * (summary.flowResolution.used), or the run's copied recipe declares exactly
 * this flow inline and its trace shows a successful call to it.
 * Honor-system limit: the developer owns both the artifacts and the catalog,
 * so hand-forged artifacts can still pass — detecting that would need signed
 * run evidence, which is out of scope.
 */
async function assertRunExercisedFlow(
  artifactsDir: string,
  summary: Record<string, unknown>,
  flowRef: string,
  flow: Record<string, unknown>,
): Promise<void> {
  const flowResolution = summary.flowResolution;
  if (isRecord(flowResolution) && Array.isArray(flowResolution.used)) {
    if (flowResolution.used.some((entry) => isRecord(entry) && entry.ref === flowRef)) return;
  }

  let runRecipe: unknown;
  try {
    runRecipe = await readJsonFile(path.join(artifactsDir, 'recipe.json'));
  } catch {
    throw evidenceError(flowRef, artifactsDir, 'the run artifacts have no readable recipe.json');
  }
  const runFlow =
    isRecord(runRecipe) && isRecord(runRecipe.flows) ? runRecipe.flows[flowRef] : undefined;
  if (!isRecord(runFlow)) {
    throw evidenceError(
      flowRef,
      artifactsDir,
      'the run neither resolved the flow from a library nor declared it inline in its recipe',
    );
  }
  if (!isDeepStrictEqual(runFlow, flow)) {
    throw evidenceError(
      flowRef,
      artifactsDir,
      'the run recipe declares a different definition of the flow than the one being promoted',
    );
  }
  const callNodeIds = collectCallNodeIds(runRecipe, flowRef);
  if (callNodeIds.size === 0) {
    throw evidenceError(flowRef, artifactsDir, 'the run recipe never calls the flow');
  }
  const traceEntries = await readTraceEntries(artifactsDir);
  const executed = traceEntries.some(
    (entry) =>
      isRecord(entry) &&
      entry.ok === true &&
      typeof entry.nodeId === 'string' &&
      callNodeIds.has(entry.nodeId),
  );
  if (!executed) {
    throw evidenceError(flowRef, artifactsDir, 'the run trace has no successful call to the flow');
  }
}

function evidenceError(flowRef: string, artifactsDir: string, reason: string): Error {
  return new Error(
    `Cannot stamp lastVerified for ${flowRef} from ${artifactsDir}: ${reason}. Pass artifacts of a run that exercised this flow, or promote without --run.`,
  );
}

async function readTraceEntries(artifactsDir: string): Promise<unknown[]> {
  let trace: unknown;
  try {
    trace = await readJsonFile(path.join(artifactsDir, 'trace.json'));
  } catch {
    return [];
  }
  if (Array.isArray(trace)) return trace;
  if (isRecord(trace) && Array.isArray(trace.entries)) return trace.entries;
  return [];
}

/** Node ids of every `call` to the ref, anywhere a recipe can declare nodes. */
function collectCallNodeIds(
  recipe: unknown,
  flowRef: string,
  out = new Set<string>(),
): Set<string> {
  if (!isRecord(recipe)) return out;
  if (
    isRecord(recipe.startState) &&
    recipe.startState.action === 'call' &&
    recipe.startState.ref === flowRef
  ) {
    out.add('startState');
  }
  for (const [key, child] of Object.entries(recipe)) {
    if (key === 'nodes' && isRecord(child)) {
      for (const [nodeId, node] of Object.entries(child)) {
        if (isRecord(node) && node.action === 'call' && node.ref === flowRef) out.add(nodeId);
      }
    }
    collectCallNodeIds(child, flowRef, out);
  }
  return out;
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

async function findFlowDeclarations(targetRoot: string, ref: string): Promise<string[]> {
  const declarations: string[] = [];
  for (const file of await listFlowCatalogFiles(targetRoot)) {
    const catalogPath = path.join(targetRoot, LIBRARY_FLOWS_DIR, file);
    const catalog = await readJsonFile(catalogPath);
    if (isRecord(catalog) && isRecord(catalog.flows) && catalog.flows[ref] != null) {
      declarations.push(catalogPath);
    }
  }
  return declarations;
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
