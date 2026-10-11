// Run the sample recipe and retain the existing QA suite contract for its admitted task.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [cliInput, checkoutInput] = process.argv.slice(2);
const cli = await fs.realpath(cliInput);
const checkout = await fs.realpath(checkoutInput);
if (!process.env.FARMSLOT_TASK_DIR) throw new Error('The scripted worker must supply FARMSLOT_TASK_DIR.');
const taskDir = await fs.realpath(process.env.FARMSLOT_TASK_DIR);
const taskRelative = path.relative(checkout, taskDir);
if (!taskRelative || taskRelative.startsWith('..') || path.isAbsolute(taskRelative)) {
  throw new Error('The QA task must be inside its prepared checkout.');
}
const require = createRequire(cli);
const load = async name => import(pathToFileURL(require.resolve(name)).href);
const { digestRecipeDocument, RECIPE_SUITE_SCOPE_SCHEMA_URL } = await load('@farmslot/protocol');
const { freezeRecipeSuiteScope, finalizeRecipeSuite } = await load('@farmslot/recipe-runner');
const { runOwnedRecipeProcess } = await load('@farmslot/recipe-runner/adapters/core');
const { withRecipeSignals } = await load('@farmslot/recipe-cli/harness');
const input = JSON.parse(await fs.readFile(path.join(taskDir, 'inputs/qa.json'), 'utf8'));
assert.equal(input.version, 1);
assert.equal(input.project, 'example-app-farm');
assert.equal(typeof input.runId, 'string');
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
if (input.source?.headSha) assert.equal(input.source.headSha, headSha);
const source = { baseSha: input.source?.baseSha ?? headSha, headSha };
const recipe = JSON.parse(await fs.readFile(new URL('../recipes/headless/smoke.recipe.json', import.meta.url), 'utf8'));
const scope = freezeRecipeSuiteScope({ $schema: RECIPE_SUITE_SCOPE_SCHEMA_URL, suite_id: input.runId, cases: [{ id: 'smoke' }] });
const sourceScope = { ...source, recipe: 'smoke', recipeDigest: digestRecipeDocument(recipe) };
const artifacts = path.join(taskDir, 'artifacts');
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(artifacts, 'qa-scope.json'), JSON.stringify(sourceScope, null, 2) + '\n');
const packageRelative = 'suite/cases/smoke';
const recipeArtifacts = path.join(taskRelative, 'artifacts', packageRelative);
const result = await withRecipeSignals(signal => runOwnedRecipeProcess(cli, [
  'recipe', 'run', 'smoke', '--project', 'example-app-farm', '--target', checkout,
  '--artifacts-dir', recipeArtifacts, '--json',
], { cwd: checkout, env: process.env, signal, timeoutMs: 45000 }));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.timedOut || result.exitCode !== 0) process.exit(result.timedOut ? 124 : result.exitCode);
const execution = JSON.parse(result.stdout).result;
assert.equal(execution.status, 'pass');
const packageDir = await fs.realpath(path.join(artifacts, packageRelative));
assert.equal(await fs.realpath(path.dirname(execution.summaryPath)), packageDir);
const resolution = JSON.parse(await fs.readFile(path.join(packageDir, 'recipe-resolution.json'), 'utf8'));
assert.equal(resolution.root.digest, sourceScope.recipeDigest);
await finalizeRecipeSuite({ scope, resolutions: [{ id: 'smoke', kind: 'verdict', result: execution }], outputDir: path.join(artifacts, 'suite') });
const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
assert.equal(currentHead, headSha);
await fs.writeFile(path.join(artifacts, 'qa-result.json'), JSON.stringify({
  version: 1, runId: input.runId, qa: { profile: input.profile, inputs: input.inputs }, source,
  suitePath: 'suite', packages: { smoke: packageRelative }, smoke: { caseId: 'smoke', proofTarget: 'note' },
  scope: { path: 'qa-scope.json', digest: digestRecipeDocument(sourceScope), suiteDigest: digestRecipeDocument(scope.scope) },
}, null, 2) + '\n');
