import path from 'node:path';

import {
  Events,
  type RunRefreshPublishedEvidenceParams,
  type RunRefreshPublishedEvidenceResult,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';
import { latestResolvedHumanGateDecision } from '../run-engine/decision-replay.js';
import { recordPublishedDescription } from '../run-engine/finalize-step.js';
import { getRun } from '../runs/store.js';

import { evidenceManifestArtifactPaths } from './evidence-manifest.js';
import { isPublishedStatus, publicationStatusForRun } from './orchestrator.js';
import { buildPackageEvidenceManifest } from './package-evidence-manifest.js';
import {
  assertSelectedEvidencePublished,
  expandEvidenceSelectionForManifest,
  postProcessPRBody,
  readEvidenceManifest,
  scanArtifacts,
  uploadArtifacts,
} from './publication-artifacts.js';
import { assertPublicationEvidenceSelection } from './publication-evidence-policy.js';
import { sha256Text, verifyReadyGateSelectedEvidenceFiles } from './ready-gate-package.js';

interface PublishedPrDescription {
  body: string;
  title: string;
  headRefName: string;
  headRefOid: string;
  state: string;
}

/** Repairs evidence delivery on an already published PR; never reopens approval or changes code. */
export async function refreshPublishedEvidence(
  params: RunRefreshPublishedEvidenceParams,
  emit: (event: string, payload: unknown) => void,
): Promise<RunRefreshPublishedEvidenceResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  if (run.readOnly) throw new Error('Imported runs cannot refresh published evidence');
  if (!isPublishedStatus(publicationStatusForRun(run)) || !run.prNumber) {
    throw new Error('Evidence refresh requires an already published PR');
  }
  if (run.status !== 'done' || run.activeTaskFile) {
    throw new Error('Wait for the published run to finish before refreshing its evidence');
  }
  if (!run.taskFile) throw new Error('Published evidence requires the run artifact mirror');
  const decision = latestResolvedHumanGateDecision(run.decisions);
  const payload = decision?.payload as { kind?: string; prPackage?: unknown } | undefined;
  if (payload?.kind !== 'ready' || !payload.prPackage) {
    throw new Error('Published evidence refresh requires the recorded publication package');
  }
  const manifest = await readEvidenceManifest(run);
  if (!manifest) throw new Error('Published evidence refresh requires a valid evidence manifest');
  const inventory = await buildPackageEvidenceManifest(
    path.dirname(run.taskFile),
    await scanArtifacts(path.dirname(run.taskFile)),
    manifest,
  );
  const selected = assertPublicationEvidenceSelection({
    selectedEvidenceKeys: params.selectedEvidenceKeys ?? evidenceManifestArtifactPaths(manifest),
    evidenceManifest: inventory,
    trustedEvidenceManifest: manifest,
  });
  const expanded = expandEvidenceSelectionForManifest(manifest, selected) ?? [];
  if (expanded.length === 0) throw new Error('No local visual evidence is available to refresh');
  // Use current mirrored evidence without rewriting the historical approved package or review stamps.
  await verifyReadyGateSelectedEvidenceFiles(run, { evidenceManifest: inventory }, expanded);
  const vars = await loadProjectVars(run.project);
  const ciRepo = vars.projectJson.ci?.repo;
  if (!ciRepo || !getProjectField(vars.projectJson, 'artifacts_repo')) {
    throw new Error('Published evidence requires configured PR and artifacts repositories');
  }
  const readPr = async (): Promise<PublishedPrDescription> => {
    const result = await ghRequest(
      [
        'pr',
        'view',
        String(run.prNumber),
        '--repo',
        ciRepo,
        '--json',
        'body,title,headRefName,headRefOid,state',
      ],
      { force: true },
    );
    return JSON.parse(result.stdout) as PublishedPrDescription;
  };
  const before = await readPr();
  if (!run.branch || before.headRefName !== run.branch || before.state === 'CLOSED') {
    throw new Error('Published PR no longer matches the run branch');
  }
  const artifactUrls = await uploadArtifacts(run, run.prNumber, expanded, { failOnError: true });
  assertSelectedEvidencePublished(expanded, artifactUrls);
  const postedBody = await postProcessPRBody(run, ciRepo, run.prNumber, artifactUrls, expanded, {
    failOnError: true,
    baseBody: before.body,
    evidenceManifest: manifest,
    validateBody: async () => {
      await verifyReadyGateSelectedEvidenceFiles(run, { evidenceManifest: inventory }, expanded);
      const current = await readPr();
      if (current.headRefOid !== before.headRefOid || current.body !== before.body) {
        throw new Error(
          'Published PR changed during evidence refresh; retry against its current state',
        );
      }
    },
  });
  if (postedBody === null) throw new Error('Published evidence body was not posted');
  const publishedAt = new Date().toISOString();
  recordPublishedDescription(
    run.id,
    decision?.id,
    { draftTitle: before.title, draftBody: postedBody },
    publishedAt,
  );
  emit(Events.RUN_UPDATED, { run: getRun(run.id) });
  return {
    runId: run.id,
    prNumber: run.prNumber,
    ciRepo,
    selectedEvidenceKeys: expanded,
    artifactUrls: Object.fromEntries(artifactUrls),
    bodyHash: sha256Text(postedBody),
    publishedAt,
  };
}
