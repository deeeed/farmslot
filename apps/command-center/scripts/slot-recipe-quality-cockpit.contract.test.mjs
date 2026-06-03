import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const uiRoot = path.join(repoRoot, 'ui', 'src', 'components');

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function walkFiles(dir) {
  const entries = readdirSync(dir).sort();
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function anyComponentSourceMatches(pattern) {
  return walkFiles(uiRoot)
    .filter((file) => file.endsWith('.ts'))
    .some((file) => pattern.test(readFileSync(file, 'utf8')));
}

function expectIncludes(source, pattern, message) {
  assert.equal(pattern.test(source), true, message);
}

function expectExcludes(source, pattern, message) {
  assert.equal(pattern.test(source), false, message);
}

test('shared recipe cockpit files are present', () => {
  assert.equal(
    existsSync(
      path.join(repoRoot, 'ui', 'src', 'components', 'recipe', 'recipe-quality-cockpit.ts'),
    ),
    true,
    'expected ui/src/components/recipe/recipe-quality-cockpit.ts to exist',
  );
  assert.equal(
    anyComponentSourceMatches(/\bSlotViewRecipeHostEntry\b/),
    true,
    'expected a SlotViewRecipeHostEntry definition or usage somewhere under ui/src/components',
  );
});

test('review-workspace is migrated onto the shared recipe cockpit without gaining retrospective-only controls', () => {
  const source = read('ui/src/components/workspace/review-workspace.ts');
  expectIncludes(
    source,
    /recipe-quality-cockpit/,
    'review-workspace should reference the shared recipe cockpit',
  );
  expectIncludes(
    source,
    /Propose improvement \(LLM\)/,
    'review-workspace must retain the improvement CTA',
  );
  expectIncludes(
    source,
    /recipe-output-panel/,
    'review-workspace must retain recipe-output-panel wiring',
  );
  expectExcludes(
    source,
    /Dispatch fresh run/,
    'review-workspace must not gain family-observability dispatch controls',
  );
  expectExcludes(source, /Human grade/, 'review-workspace must not gain grading UI');
});

test('review-workspace keeps recipe hosting anchored to the active review decision payload', () => {
  const workspaceSource = read('ui/src/components/workspace/review-workspace.ts');
  const hostSource = read('ui/src/components/recipe/recipe-quality-hosts.ts');
  expectIncludes(
    workspaceSource,
    /createReviewWorkspaceRecipeHostEntry\(\{\s*runId:\s*this\.runId,\s*slotId:\s*this\.slotId,\s*branch:\s*this\.branch \|\| null,\s*payload,\s*\}\)/s,
    'review-workspace should continue assembling recipe state from the current decision payload',
  );
  expectIncludes(
    hostSource,
    /createReviewWorkspaceRecipeHostEntry\(args:\s*\{[\s\S]*payload:\s*ReviewGatePayload;/,
    'review-workspace host helper should remain review-gate specific',
  );
  expectIncludes(
    hostSource,
    /canRerun:\s*Boolean\(args\.payload\.recipeJson && args\.slotId\)/,
    'review-workspace rerun availability should stay decision-backed',
  );
});

test('family-observability keeps canonical retrospective controls while using the shared cockpit', () => {
  const source = read('ui/src/components/runs/family-observability.ts');
  expectIncludes(
    source,
    /(renderRecipeQualityCockpit|createFamilyObservabilityRecipeHostEntry|recipe-quality-cockpit|recipe-quality-hosts)/,
    'family-observability should reference the shared recipe cockpit or its host adapter',
  );
  expectIncludes(source, /Dispatch fresh run/, 'family-observability must retain dispatch-fresh');
  expectIncludes(source, /Human grade/, 'family-observability must retain grading UI');
  expectIncludes(
    source,
    /recipe-output-panel/,
    'family-observability must retain recipe-output-panel wiring',
  );
});

test('family-observability keeps retrospective-only ownership in the shared host layer', () => {
  const familySource = read('ui/src/components/runs/family-observability.ts');
  const hostSource = read('ui/src/components/recipe/recipe-quality-hosts.ts');
  expectIncludes(
    familySource,
    /afterActionContent:\s*html`[\s\S]*\$\{this\._renderGradingPanel\(selectedRun\)\}[\s\S]*\$\{this\._renderImprovementTrigger\(selectedRun\)\}/,
    'family-observability should continue owning grading and improvement controls around the shared cockpit',
  );
  expectIncludes(
    hostSource,
    /qualityReport:\s*null,/,
    'family-observability host entries should not inherit review-only quality reports',
  );
  expectIncludes(
    hostSource,
    /canCancel:\s*false,/,
    'family-observability host entries should not gain review-workspace cancel ownership',
  );
});

test('slot-view keeps drawer chrome while hosting recipe content via SlotViewRecipeHostEntry', () => {
  const source = read('ui/src/components/slot-view/slot-view.ts');
  expectIncludes(
    source,
    /\bSlotViewRecipeHostEntry\b|createSlotViewRecipeHostEntry|recipe-quality-hosts/,
    'slot-view should use the explicit SlotViewRecipeHostEntry model or slot-view host adapter',
  );
  expectIncludes(
    source,
    /(renderRecipeQualityCockpit|recipe-quality-cockpit|recipe-quality-hosts)/,
    'slot-view should reference the shared recipe cockpit or adapter',
  );
  expectIncludes(source, /sv-review-col/, 'slot-view should retain the right drawer chrome');
  expectIncludes(
    source,
    /_reviewFullWidth/,
    'slot-view should retain fullscreen\/restore drawer behavior',
  );
  expectExcludes(source, /Dispatch fresh run/, 'slot-view must not gain dispatch-fresh controls');
  expectExcludes(source, /Human grade/, 'slot-view must not gain grading UI');
});

test('dev harness exposes a dedicated recipe provenance matrix route', () => {
  const source = read('ui/src/dev/dev-harness.ts');
  expectIncludes(
    source,
    /recipe-provenance-matrix/,
    'dev harness should expose a recipe-provenance-matrix route',
  );
  expectIncludes(
    source,
    /renderRecipeProvenanceMatrix/,
    'dev harness should render a dedicated recipe provenance matrix surface',
  );
  expectIncludes(
    source,
    /Expected outcome:/,
    'matrix route should document the active scenario expectation',
  );
});
