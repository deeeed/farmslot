import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeJson } from '../lib/isolated-stack.mjs';

import { MARKER_TICKET, fixtureGit, markerTemplateStep, recordMarkerEvidence } from './marker-contract-fixture.mjs';
import type { CheckResult } from './outcome.mjs';

type MarkerCommitVerifier = (output: string, baseSha: string, markerSha: string, ticket: string) => Promise<boolean>;

export async function runMarkerContract(evidence: string): Promise<CheckResult> {
  const started = Date.now();
  const dir = path.join(evidence, 'marker-contract');
  await mkdir(dir, { recursive: true });
  const check: CheckResult = { case: 'marker-contract', variant: '-', target: 'isolated', status: 'fail', model: 'none', modelCalls: 0, differences: [], observations: [], evidence: dir };
  let fixture: string | undefined;
  try {
    const cook = path.resolve((process.env.CONSENSYS_RECIPE_COOK_ROOT ?? path.join(homedir(), 'dev/metamask/consensys-skills/domains/agentic/skills/recipe-cook')).replace(/^~(?=\/|$)/, homedir()));
    const template = path.join(cook, 'references/templates/fix-bug/mobile.md');
    const text = await readFile(template, 'utf8');
    const revision = execFileSync('git', ['-C', cook, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeJson(path.join(dir, 'template.json'), { path: template, revision, text });
    check.observations.push(`Recipe Cook: ${template} @ ${revision}`);
    const step = markerTemplateStep(text);
    fixture = await mkdtemp(path.join(tmpdir(), 'marker-contract-'));
    const repo = path.join(fixture, 'repo');
    const taskDir = path.join(fixture, 'task');
    const f = await recordMarkerEvidence(repo, taskDir, step);
    await writeJson(path.join(dir, 'fixture.json'), { ...f, step, ticket: MARKER_TICKET, flowType: 'fix-bug', syntheticMedia: true });
    await cp(path.join(taskDir, 'artifacts'), path.join(dir, 'artifacts'), { recursive: true });
    const { resolvePublicationManifest } = await import('../../../services/gateway/src/run-completion/publication-artifacts.js');
    const { recordedPublicationDependencies } = await import('../../../services/gateway/src/run-completion/recorded-publication-evidence.js');
    const markerFile = fileURLToPath(new URL('../../../services/gateway/src/run-completion/baseline-debug-marker.ts', import.meta.url));
    const marker: { isTicketMarkerCommit: MarkerCommitVerifier } | undefined = existsSync(markerFile)
      ? await import(pathToFileURL(markerFile).href) : undefined;
    const baseline = {
      baseSha: f.baseSha, headSha: f.headSha, branch: f.branch, inventory: f.inventory,
      // Use the engine's verifier with local Git transport, avoiding slot config and live IO.
      ...(marker ? { markerBaseline: async (markerSha: string, baseSha: string) => marker.isTicketMarkerCommit(
        fixtureGit(repo, '--no-replace-objects', 'show', '--format=%H%x00%P%x00%s%x00', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', markerSha, '--'),
        baseSha, markerSha, MARKER_TICKET,
      ) } : {}),
    };
    const resolved = await resolvePublicationManifest(taskDir, undefined, undefined, 1, baseline);
    if (!resolved) throw new Error('Marker contract produced no publication manifest.');
    const dependencies = await recordedPublicationDependencies(taskDir, f.inventory, f.inventory.filter((entry) => entry.purpose === 'screenshot'), resolved.manifest, 1, baseline);
    await writeJson(path.join(dir, 'publication.json'), { manifest: resolved.manifest, dependencies });
    check.observations.push('Real publication manifest and recorded dependency closure admitted marker-SHA baseline evidence.');
    check.status = 'pass';
  } catch (error) {
    check.error = error instanceof Error ? error.message : String(error);
    check.failureText = check.error;
  } finally {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    check.durationS = (Date.now() - started) / 1000;
    await writeJson(path.join(dir, 'check.json'), check);
  }
  return check;
}
