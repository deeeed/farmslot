import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef } from '@farmslot/protocol';

export const MARKER_TICKET = 'MANUAL-000180';
const source = `const DevLogger = { log() {} };
export function sum(a, b) {
  return a - b;
}
`;

export function markerTemplateStep(text: string): string {
  const matches = [...text.matchAll(/^- \[[ xX]\] \d+\. ([^\n]+)/gm)];
  const steps = matches.map((match, index) => ({
    label: match[1]!,
    text: text.slice(match.index, matches[index + 1]?.index ?? text.length).trimEnd(),
    index: match.index,
  }));
  const markers = steps.filter(
    (step) =>
      /[Cc]ommit it alone as `debug\(<ticket>\): add reproduction marker`/.test(step.text) &&
      step.text.includes('[<ticket>] BUG_MARKER:'),
  );
  const drafts = steps.filter((step) => /\bdraft\b.*\bbaseline\b.*\brecipe\b/i.test(step.label));
  const recordings = steps.filter((step) => /\brecorded baseline\b/i.test(step.label));
  const marker = markers[0];
  const draft = drafts[0];
  const recorded = recordings[0];
  if (
    markers.length !== 1 ||
    drafts.length !== 1 ||
    recordings.length !== 1 ||
    !marker ||
    !draft ||
    !recorded ||
    marker.index >= draft.index ||
    draft.index >= recorded.index
  )
    throw new Error(
      'Recipe Cook mobile must commit the marker alone as debug(<ticket>): add reproduction marker before drafting and recording the baseline.',
    );
  markerDiagnosticStatement(marker.text);
  return marker.text;
}

function markerDiagnosticStatement(step: string): string {
  const statements = [...step.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!)
    .filter(
      (statement) =>
        /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*\);?$/.test(statement) &&
        statement.includes('[<ticket>] BUG_MARKER: <condition>'),
    );
  if (statements.length !== 1)
    throw new Error(
      'Recipe Cook mobile marker step must prescribe one backticked diagnostic call.',
    );
  return statements[0]!
    .replaceAll('<ticket>', MARKER_TICKET)
    .replaceAll('<condition>', 'sum subtracts');
}

export function fixtureGit(repo: string, ...args: string[]): string {
  // Git inherited from a hook must never redirect a fixture command into the real checkout.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key))
      delete env[key];
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { env, encoding: 'utf8', stdio: 'pipe' },
  ).trimEnd();
}

export async function createMarkerRepo(repo: string, step: string) {
  const statement = markerDiagnosticStatement(step);
  await mkdir(repo, { recursive: true });
  fixtureGit(repo, 'init', '-q', '-b', 'marker-contract');
  fixtureGit(repo, 'config', 'user.name', 'Fixture');
  fixtureGit(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'source.mjs'), source);
  fixtureGit(repo, 'add', 'source.mjs');
  fixtureGit(repo, 'commit', '-qm', 'test: seed buggy base');
  const baseSha = fixtureGit(repo, 'rev-parse', 'HEAD');
  await writeFile(
    path.join(repo, 'source.mjs'),
    source.replace('  return', `  ${statement}\n  return`),
  );
  fixtureGit(repo, 'commit', '-qam', `debug(${MARKER_TICKET}): add reproduction marker`);
  const markerSha = fixtureGit(repo, 'rev-parse', 'HEAD');
  const patch = fixtureGit(
    repo,
    '--no-replace-objects',
    'show',
    '--format=%H%x00%P%x00%s%x00',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--unified=0',
    markerSha,
    '--',
  );
  return { baseSha, markerSha, patch, branch: 'marker-contract' };
}

export async function fixMarkerRepo(repo: string): Promise<string> {
  await writeFile(path.join(repo, 'source.mjs'), source.replace('a - b', 'a + b'));
  fixtureGit(repo, 'commit', '-qam', 'fix: add instead of subtracting and remove marker');
  return fixtureGit(repo, 'rev-parse', 'HEAD');
}

export async function recordMarkerEvidence(repo: string, taskDir: string, step: string) {
  const { createRecipeRunner, createStandardCoreAdapters, readRecordedEvidencePackage } =
    await import('@farmslot/recipe-runner');
  const { RECIPE_ACTION_MANIFEST_SCHEMA_URL } = await import('@farmslot/protocol');
  const topology = await createMarkerRepo(repo, step);
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        command: {
          description: 'Run the sum CLI.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [{ action: 'command', cmd: 'node --version', intent: 'Read.', next: 'check' }],
        },
        assert_output: {
          description: 'Assert the sum.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'read',
              contains: '5',
              intent: 'Check.',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
  });
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Sum is five',
    description: 'Synthetic publication contract fixture, no mobile runtime claim.',
    proofTargets: [{ id: 'AC-1', claim: 'Sum of two and three is five.', proofMode: 'state' }],
    workflow: {
      entry: 'read',
      nodes: {
        read: {
          action: 'command',
          cmd: `node --input-type=module -e 'import { sum } from "./source.mjs"; console.log(sum(2, 3))'`,
          intent: 'Run sum.',
          next: 'check',
        },
        check: {
          action: 'assert_output',
          source: 'read',
          contains: '5',
          proves: ['AC-1'],
          intent: 'Check sum.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const baselineRoot = 'recipe-runs/baseline';
  const headRoot = 'recipe-runs/current';
  const before = await runner.run({
    projectRoot: repo,
    artifactsDir: path.join(taskDir, 'artifacts', baselineRoot),
    recipeDocument: recipe,
  });
  const headSha = await fixMarkerRepo(repo);
  const after = await runner.run({
    projectRoot: repo,
    artifactsDir: path.join(taskDir, 'artifacts', headRoot),
    recipeDocument: recipe,
  });
  if (
    before.claims.criteria[0]?.verdict !== 'failed' ||
    after.claims.criteria[0]?.verdict !== 'proven'
  )
    throw new Error(
      `Marker fixture must record a failing baseline and passing head recipe: ${JSON.stringify({ before: before.claims, after: after.claims })}`,
    );
  const inventory: ArtifactRef[] = [];
  for (const [root, sha] of [
    [baselineRoot, topology.markerSha],
    [headRoot, headSha],
  ] as const) {
    const dir = path.join(taskDir, 'artifacts', root);
    // One-pixel synthetic media selects the before/after rule, not device or visual proof.
    await writeFile(
      path.join(dir, 'proof.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    await writeFile(
      path.join(dir, 'product-provenance.json'),
      JSON.stringify({ schemaVersion: 1, git_ref: sha, dirty: false, branch: topology.branch }),
    );
    const manifestPath = path.join(dir, 'artifact-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push(
      { path: 'proof.png', type: 'screenshot' },
      { path: 'product-provenance.json', type: 'json', category: 'system' },
    );
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { input, checks } = await readRecordedEvidencePackage(dir);
    const failed = checks.find((check) => check.status === 'fail');
    if (failed) throw new Error(failed.message);
    for (const file of input.artifactPaths ?? [])
      inventory.push({
        path: `artifacts/${root}/${file}`,
        purpose: file === 'proof.png' ? 'screenshot' : 'other',
        sha256: input.artifactDigests[file],
      });
  }
  await writeFile(
    path.join(taskDir, 'artifacts', headRoot, 'evidence-manifest.json'),
    JSON.stringify({ version: 1, standalone: [{ label: 'Head proof', file: 'proof.png' }] }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: headRoot }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      before_after_pairs: [
        {
          label: 'Sum',
          covers: ['AC-1'],
          before: `${baselineRoot}/proof.png`,
          after: `${headRoot}/proof.png`,
        },
      ],
    }),
  );
  return { ...topology, headSha, baselineRoot, headRoot, inventory };
}
