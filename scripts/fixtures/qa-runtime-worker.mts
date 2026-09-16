import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
  freezeRecipeSuiteScope,
  finalizeRecipeSuite,
} from '../../packages/recipe-harness/src/index.js';
import { digestRecipeDocument } from '../../packages/protocol/src/index.js';

const scenario = process.argv[2];
const repository = process.cwd();
const root = fileURLToPath(new URL('../../', import.meta.url));
async function findInputs(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findInputs(file)));
    else if (entry.name === 'qa.json' && path.basename(dir) === 'inputs') found.push(file);
  }
  return found;
}
const inputs = await findInputs(path.join(repository, '.task'));
assert.equal(inputs.length, 1);
const input = JSON.parse(await readFile(inputs[0], 'utf8'));
const task = path.dirname(path.dirname(inputs[0]));
const artifacts = path.join(task, 'artifacts');
const suite = path.join(artifacts, 'qa-suite');
await mkdir(suite, { recursive: true });
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
}).trim();
const source = input.source ?? { headSha, baseSha: headSha };
const changeScope = { ...source, kind: 'range', files: [] };
const suiteDocument = {
  $schema: 'https://farmslot.io/schemas/recipe-suite-scope-v1.schema.json' as const,
  suite_id: 'controller-changes',
  cases: [{ id: 'smoke' }],
};
await writeFile(path.join(artifacts, 'qa-scope.json'), JSON.stringify(changeScope));
await writeFile(
  path.join(artifacts, 'qa-result.json'),
  JSON.stringify({
    version: 1,
    runId: input.runId,
    qa: { profile: input.profile, inputs: input.inputs },
    source,
    suitePath: 'qa-suite',
    scope: {
      path: 'qa-scope.json',
      digest: digestRecipeDocument(changeScope),
      suiteDigest: digestRecipeDocument(suiteDocument),
    },
    packages: { smoke: 'qa-suite/smoke' },
    smoke: { caseId: 'smoke', proofTarget: 'increment' },
  }),
);
let count = 0;
const requests: Array<{ method: string; path: string; value: number }> = [];
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/increment') count++;
  requests.push({ method: request.method!, path: request.url!, value: count });
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ count }));
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const actions = ['command', 'assert_output', 'end'];
const catalog = JSON.parse(
  await readFile(path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'), 'utf8'),
);
const runner = createRecipeRunner({
  actionManifest: {
    $schema: catalog.$schema,
    actions: Object.fromEntries(actions.map((name) => [name, catalog.actions[name]])),
  },
  adapters: createStandardCoreAdapters({ actions }),
  runner: { name: 'Fixture controller validation', source: 'worktree', git_ref: headSha },
});
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
try {
  const scope = freezeRecipeSuiteScope(suiteDocument);
  if (scenario === 'unexecuted') {
    await finalizeRecipeSuite({
      scope,
      outputDir: suite,
      resolutions: [
        {
          id: 'smoke',
          kind: 'not_executed',
          reason_class: 'prerequisite_missing',
          detail: 'Required controller unavailable',
        },
      ],
    });
  } else if (scenario === 'empty-scope') {
    // Fault injection removes scope; no fabricated execution trace or passing recipe.
    const emptyScope = { ...scope.scope, cases: [] };
    await writeFile(path.join(suite, 'suite-scope.json'), JSON.stringify(emptyScope));
    await writeFile(
      path.join(suite, 'suite-result.json'),
      JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-suite-result-v1.schema.json',
        suite_id: scope.scope.suite_id,
        scope_digest: digestRecipeDocument(emptyScope),
        totals: { declared: 0, executed: 0, not_executed: 0 },
        resolutions: [],
      }),
    );
  } else {
    const program = `const first=await fetch('http://127.0.0.1:${port}/count').then(r=>r.json());const next=await fetch('http://127.0.0.1:${port}/increment',{method:'POST'}).then(r=>r.json());console.log(JSON.stringify({before:first.count,after:next.count}));`;
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Controller increment smoke',
      proofTargets: [
        { id: 'increment', claim: 'Increment mutates controller state from zero to one' },
      ],
      workflow: {
        entry: 'exercise',
        nodes: {
          exercise: {
            action: 'command',
            cmd: `${quote(process.execPath)} --input-type=module -e ${quote(program)}`,
            next: 'assert',
            intent: 'Read and increment the running controller.',
          },
          assert: {
            action: 'assert_output',
            source: 'exercise',
            contains: JSON.stringify({ before: 0, after: scenario === 'failing-smoke' ? 2 : 1 }),
            proves: ['increment'],
            intent: 'Verify controller state changed to the required value.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(suite, 'smoke'),
      projectRoot: repository,
      source: { kind: 'operator', trust: 'trusted', name: 'Fixture controller smoke' },
    });
    await finalizeRecipeSuite({
      scope,
      outputDir: suite,
      resolutions: [{ id: 'smoke', kind: 'verdict', result }],
    });
    if (scenario === 'mismatched-scope')
      await writeFile(
        path.join(artifacts, 'qa-scope.json'),
        JSON.stringify({ ...changeScope, baseSha: 'f'.repeat(40) }),
      );
    if (scenario === 'missing-package') await rm(path.join(suite, 'smoke', 'trace.json'));
    if (scenario === 'missing-smoke') {
      const envelope = JSON.parse(await readFile(path.join(artifacts, 'qa-result.json'), 'utf8'));
      envelope.smoke.caseId = 'missing';
      await writeFile(path.join(artifacts, 'qa-result.json'), JSON.stringify(envelope));
    }
    await writeFile(
      path.join(artifacts, 'controller-observations.json'),
      JSON.stringify({
        requests,
        count,
        recipeDigest: digestRecipeDocument(recipe),
        status: result.status,
      }),
    );
  }
  await writeFile(
    path.join(artifacts, 'qa-report.md'),
    `Controller QA ${scenario}. See the recipe suite for its actual verdict.\n`,
  );
  await writeFile(
    path.join(artifacts, 'learnings.md'),
    'Controller QA evidence is generated by the recipe runner; unavailable or failing cases remain explicit.\n',
  );
  const checklist = path.join(task, 'CHECKLIST.md');
  await writeFile(checklist, (await readFile(checklist, 'utf8')).replaceAll('[ ]', '[x]'));
  // Exit success intentionally: the gateway must reject the worker's terminal success
  // when its real recipe evidence is failing/incomplete, regardless of a completed checklist.
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
