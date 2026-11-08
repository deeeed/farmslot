import { isRecord, type Run } from '@farmslot/protocol';
import {
  POLICY_VERSION,
  type RecipeShapeCatalog,
  type RecipeShapeCriterion,
  type RecipeShapeFeedback,
  scoreRecipeShape,
  stableDigest,
} from '@farmslot/protocol/recipe-shape.mjs';
import {
  filterWorkerAcceptanceCriteria,
  registeredAcceptanceCriteria,
} from '@farmslot/protocol/scripts/acceptance.mjs';

export interface RecipeShapeContext {
  catalog: RecipeShapeCatalog;
  criteria: RecipeShapeCriterion[] | null;
  nonLocalCriteria?: string[];
}
export interface RecipeShapeTexts {
  catalog: string | null;
  binding: string | null;
}
interface ShapeReadInput {
  run: Pick<Run, 'flowType'> & Partial<Pick<Run, 'ticketData' | 'acceptanceRegistration'>>;
  recipeJson?: string | null;
  stored?: RecipeShapeFeedback;
  context?: RecipeShapeContext;
  readTexts: () => Promise<RecipeShapeTexts>;
}
function parseCatalog(text: string | null): RecipeShapeCatalog | null {
  if (!text || Buffer.byteLength(text) > 8 * 1024 * 1024) return null;
  const data: unknown = JSON.parse(text);
  if (
    !isRecord(data) ||
    typeof data.available !== 'boolean' ||
    !Array.isArray(data.blocks) ||
    data.blocks.length > 2048 ||
    !Array.isArray(data.sources)
  )
    return null;
  const blocks = [];
  for (const block of data.blocks) {
    if (!isRecord(block) || typeof block.id !== 'string') return null;
    if (block.ref !== undefined && typeof block.ref !== 'string') return null;
    if (
      block.tokens !== undefined &&
      (!Array.isArray(block.tokens) || block.tokens.some((token) => typeof token !== 'string'))
    )
      return null;
    if (
      block.sig !== undefined &&
      (!Array.isArray(block.sig) || block.sig.some((token) => typeof token !== 'string'))
    )
      return null;
    blocks.push({
      id: block.id,
      ...(typeof block.ref === 'string' ? { ref: block.ref } : {}),
      ...(Array.isArray(block.tokens)
        ? { tokens: block.tokens.filter((token): token is string => typeof token === 'string') }
        : {}),
      ...(Array.isArray(block.sig)
        ? { sig: block.sig.filter((token): token is string => typeof token === 'string') }
        : {}),
    });
  }
  const sources = [];
  for (const source of data.sources) {
    if (
      !isRecord(source) ||
      typeof source.name !== 'string' ||
      (source.revision !== null && typeof source.revision !== 'string') ||
      (source.fingerprint !== null && typeof source.fingerprint !== 'string')
    )
      return null;
    sources.push({ name: source.name, revision: source.revision, fingerprint: source.fingerprint });
  }
  return { available: data.available, blocks, sources };
}
function receiptSources(text: string | null) {
  if (!text) return null;
  const data: unknown = JSON.parse(text);
  if (
    !isRecord(data) ||
    !isRecord(data.bindingIdentity) ||
    !Array.isArray(data.bindingIdentity.libraries)
  )
    return null;
  const result = [];
  for (const library of data.bindingIdentity.libraries) {
    if (!isRecord(library) || typeof library.name !== 'string') return null;
    result.push({
      name: library.name,
      revision: typeof library.head === 'string' ? library.head : null,
      fingerprint: typeof library.sourceFingerprint === 'string' ? library.sourceFingerprint : null,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export async function readRecipeShapeFeedback(
  input: ShapeReadInput,
): Promise<RecipeShapeFeedback | undefined> {
  if ((!input.stored && !input.context) || !input.recipeJson) return undefined;
  let recipe: unknown;
  try {
    recipe = JSON.parse(input.recipeJson);
  } catch {
    // Structural evaluation reports malformed recipe JSON; shape adds no verdict.
    return undefined;
  }
  if (!isRecord(recipe) || !isRecord(recipe.workflow) || !isRecord(recipe.workflow.nodes))
    return undefined;
  if (input.context) return scoreRecipeShape({ recipe, ...input.context });
  const registered = input.run.ticketData?.acceptanceCriteria
    ? registeredAcceptanceCriteria(
        input.run.ticketData.acceptanceCriteria,
        input.run.acceptanceRegistration,
      )
    : null;
  const criteria = registered
    ? filterWorkerAcceptanceCriteria(
        registered,
        input.run.acceptanceRegistration,
        input.run.flowType,
      )
    : null;
  const localIds = new Set(criteria?.map((row) => row.id));
  const nonLocalCriteria =
    registered?.filter((row) => !localIds.has(row.id)).map((row) => row.id) ?? [];
  const unavailable = (reason: string) => {
    const feedback = scoreRecipeShape({
      recipe,
      criteria,
      nonLocalCriteria,
      catalog: { available: false, blocks: [], sources: [] },
    });
    feedback.hints.unshift({ kind: 'catalog', message: reason });
    return feedback;
  };
  if (input.stored?.policyVersion !== POLICY_VERSION)
    return unavailable('Shape policy changed; run feedback again.');
  const texts = await input.readTexts();
  let catalog, sources;
  try {
    catalog = parseCatalog(texts.catalog);
    sources = receiptSources(texts.binding);
  } catch {
    return unavailable('Shape catalog or binding receipt is invalid; run feedback again.');
  }
  if (!catalog || !sources)
    return unavailable(
      'Shape catalog or frozen binding identity is unavailable; run feedback again.',
    );
  const declared = catalog.sources
    .filter((source) => source.name !== 'task-local')
    .sort((a, b) => a.name.localeCompare(b.name));
  if (stableDigest(sources) !== stableDigest(declared))
    return unavailable(
      'Shape catalog sources do not match the frozen binding receipt; run feedback again.',
    );
  const feedback = scoreRecipeShape({ recipe, criteria, nonLocalCriteria, catalog });
  if (stableDigest(feedback.inputIdentity) !== stableDigest(input.stored?.inputIdentity))
    return unavailable(
      'Shape inputs changed after feedback; run feedback again before completion.',
    );
  return feedback;
}
