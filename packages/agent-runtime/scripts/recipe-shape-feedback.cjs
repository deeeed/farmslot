'use strict';
const fs = require('node:fs');
const path = require('node:path');
const shape = require('@farmslot/protocol/recipe-shape.mjs');
const {
  workerAcceptanceCriteria,
  requireHandoffAcceptanceCriteria,
} = require('./acceptance-ledger.cjs');
const { atomicWrite } = require('./mark-io.cjs');
const CATALOG_FILE = 'recipe-shape-catalog.json';

function optionalJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function collectDocuments(directory) {
  const documents = [];
  if (!fs.existsSync(directory)) return documents;
  const pending = [directory];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const recipe = optionalJson(file);
        if (recipe?.workflow?.nodes) documents.push({ file, recipe });
      }
    }
    if (documents.length > 2048) throw new Error('Shape catalog exceeds 2048 recipe documents');
  }
  return documents;
}
function catalogForSources(libraries, local = [], adapter) {
  const catalog = {
    available: Array.isArray(libraries),
    blocks: [],
    sources: [],
    adapter: adapter ?? null,
  };
  if (!Array.isArray(libraries)) return catalog;
  for (const library of libraries) {
    catalog.sources.push({
      name: library.name,
      revision: library.head ?? null,
      fingerprint: library.sourceFingerprint ?? null,
    });
    if (!library.path || !fs.existsSync(library.path)) {
      catalog.available = false;
      continue;
    }
    const root = path.join(library.path, 'recipes');
    const meta = optionalJson(path.join(library.path, 'recipe-library.json')) ?? {};
    for (const { file, recipe } of collectDocuments(root)) {
      const ref = shape.recipeShapeLibraryRef(
        library.name,
        path.relative(root, file),
        meta.platforms ?? [],
        adapter,
      );
      const block = ref ? shape.recipeShapeBlock(ref, recipe) : null;
      if (block) catalog.blocks.push(block);
    }
  }
  if (local.length) {
    catalog.sources.push({
      name: 'task-local',
      revision: null,
      fingerprint: shape.stableDigest(
        local.map(({ relativePath, recipe }) => [relativePath, shape.stableDigest(recipe)]).sort(),
      ),
    });
    for (const { relativePath, recipe } of local) {
      const ref = shape.recipeShapeLibraryRef(null, relativePath, [], adapter);
      const block = ref ? shape.recipeShapeBlock(ref, recipe) : null;
      if (block) catalog.blocks.push(block);
    }
  }
  catalog.blocks.sort((a, b) => a.id.localeCompare(b.id));
  catalog.sources.sort((a, b) => a.name.localeCompare(b.name));
  if (catalog.blocks.length > 2048 || Buffer.byteLength(JSON.stringify(catalog)) > 8 * 1024 * 1024)
    throw new Error('Shape catalog exceeds 2048 blocks or 8 MiB');
  return catalog;
}
function collectShapeCatalog(taskDir) {
  const binding = optionalJson(path.join(taskDir, 'inputs/recipe-binding.json'));
  const receipt = optionalJson(path.join(taskDir, 'artifacts/harness-provenance.json'));
  const identity = receipt?.bindingIdentity ?? binding?.identity;
  const libraries = identity?.libraries;
  const adapter = identity?.adapter;
  const localRoot = path.join(taskDir, 'artifacts/recipe-library');
  const local = collectDocuments(localRoot).map(({ file, recipe }) => ({
    relativePath: path.relative(localRoot, file),
    recipe,
  }));
  if (!Array.isArray(libraries)) return catalogForSources(libraries, local, adapter);
  const cacheKey = shape.stableDigest({
    policy: shape.POLICY_VERSION,
    adapter: adapter ?? null,
    libraries: libraries.map((lib) => [
      lib.name,
      lib.head ?? null,
      lib.sourceFingerprint ?? null,
      lib.dirtyDigest ?? null,
    ]),
    local: local
      .map(({ relativePath, recipe }) => [relativePath, shape.stableDigest(recipe)])
      .sort(),
  });
  const cached = optionalJson(path.join(taskDir, 'artifacts', CATALOG_FILE));
  if (
    libraries.every((lib) => typeof lib.sourceFingerprint === 'string') &&
    cached?.cacheKey === cacheKey &&
    cached.available
  )
    return cached;
  return { ...catalogForSources(libraries, local, adapter), cacheKey };
}
function writeIfChanged(file, text) {
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== text) atomicWrite(file, text);
}
function feedbackForTask(taskDir, { buildArtifact, isArtifact }) {
  const recipe = optionalJson(path.join(taskDir, 'artifacts/recipe.json'));
  if (!recipe) throw new Error('No bound task recipe at artifacts/recipe.json');
  const criteria = workerAcceptanceCriteria(taskDir);
  const catalog = collectShapeCatalog(taskDir);
  const localIds = new Set(criteria.map((row) => row.id));
  const nonLocalCriteria = requireHandoffAcceptanceCriteria(taskDir)
    .filter((row) => !localIds.has(row.id))
    .map((row) => row.id);
  const feedback = shape.scoreRecipeShape({ recipe, criteria, catalog, nonLocalCriteria });
  const outputPath = path.join(taskDir, 'artifacts/recipe-quality.json');
  const existing = optionalJson(outputPath);
  if (existing && !isArtifact(existing))
    throw new Error(
      'Existing recipe-quality.json is invalid; repair it before merging shape feedback',
    );
  const artifact =
    existing ??
    buildArtifact({
      verdict: 'warn',
      reasons: ['Only advisory shape was requested; the gateway derives structural quality.'],
      producer: 'worker',
      artifactRequired: false,
      sourceSignals: ['recipe.json'],
    });
  artifact.shape = feedback;
  if (!isArtifact(artifact))
    throw new Error('Shape feedback did not match the quality artifact contract');
  writeIfChanged(
    path.join(taskDir, 'artifacts', CATALOG_FILE),
    JSON.stringify(catalog, null, 2) + '\n',
  );
  writeIfChanged(outputPath, JSON.stringify(artifact, null, 2) + '\n');
  return feedback;
}
module.exports = { catalogForSources, collectShapeCatalog, feedbackForTask, CATALOG_FILE };
