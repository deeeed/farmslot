import {
  Events,
  parseGitHubPullUrl,
  type ReadyGatePayload,
  type Run,
  type RunRefreshPublishedEvidenceParams,
  type RunRefreshPublishedEvidenceResult,
  TERMINAL_RUN_STATUSES,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';
import { latestResolvedHumanGateDecision } from '../run-engine/decision-replay.js';
import { recordPublishedDescription } from '../run-engine/finalize-step.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { getCachedRunWithArchived, getRunWithArchived } from '../runs/store.js';

import { withEvidenceAttestation } from './evidence-attestation.js';
import { isPublishedStatus, publicationStatusForRun } from './orchestrator.js';
import {
  expandPublicationEvidenceSelection,
  postProcessPRBody,
  publishSelectedEvidence,
} from './publication-artifacts.js';
import { assertPublicationTextSafe } from './publication-secrets.js';
import {
  resolveSelectedEvidenceRef,
  sha256Text,
  verifyReadyGatePackageHash,
} from './ready-gate-package.js';
import {
  readFrozenPublicationManifest,
  verifyFrozenPublicationEvidence,
} from './recorded-publication-evidence.js';

interface PublishedPrDescription {
  number: number;
  url: string;
  headRepository: { nameWithOwner: string } | null;
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
  return withRunTransition(params.runId, () => refreshPublishedEvidenceLocked(params, emit));
}

function refreshIdentity(run: Run): string {
  return JSON.stringify({
    project: run.project,
    branch: run.branch,
    prNumber: run.prNumber,
    status: run.status,
    archivedAt: run.archivedAt,
    readOnly: run.readOnly,
    activeTaskFile: run.activeTaskFile,
    generation: run.engineState?.generation,
    publishGate: run.engineState?.publishGate,
    decisions: run.decisions,
    artifactBundle: run.artifactBundle,
  });
}

async function refreshPublishedEvidenceLocked(
  params: RunRefreshPublishedEvidenceParams,
  emit: (event: string, payload: unknown) => void,
): Promise<RunRefreshPublishedEvidenceResult> {
  const run = await getRunWithArchived(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  if (run.readOnly) throw new Error('Imported runs cannot refresh published evidence');
  const adoption = run.engineState?.publishGate?.humanPublicationAdoption;
  if (!isPublishedStatus(publicationStatusForRun(run)) || !run.prNumber) {
    throw new Error('Evidence refresh requires an already published PR');
  }
  // Archives preserve the last task pointer after worker ownership is released.
  if (!TERMINAL_RUN_STATUSES.includes(run.status) || (!run.archivedAt && run.activeTaskFile)) {
    throw new Error('Wait for the published run to finish before refreshing its evidence');
  }
  if (!run.taskFile) throw new Error('Published evidence requires the run artifact mirror');
  const decision = adoption
    ? run.decisions.find((entry) => entry.id === adoption.priorGate?.decisionId)
    : latestResolvedHumanGateDecision(run.decisions);
  const payload = decision?.payload as ReadyGatePayload | undefined;
  if (!decision?.id || payload?.kind !== 'ready' || !payload.prPackage) {
    throw new Error('Published evidence refresh requires the recorded publication package');
  }
  const prepared = payload.prPackage;
  verifyReadyGatePackageHash(prepared);
  if (
    adoption &&
    (adoption.runId !== run.id ||
      adoption.prNumber !== run.prNumber ||
      adoption.observedBranch !== run.branch ||
      !adoption.priorGate?.packageId ||
      !adoption.priorGate.packageHash ||
      prepared.id !== adoption.priorGate.packageId ||
      prepared.packageHash !== adoption.priorGate.packageHash ||
      (adoption.priorGate.headSha !== undefined && adoption.priorGate.headSha !== prepared.headSha))
  )
    throw new Error('Adopted publication no longer matches its attested run and frozen package');
  const identity = refreshIdentity(run);
  const assertCurrent = (current = getCachedRunWithArchived(run.id)) => {
    if (!current || refreshIdentity(current) !== identity)
      throw new Error('Published run changed during evidence refresh');
  };
  const inventory = prepared.evidenceManifest ?? [];
  const manifest = await readFrozenPublicationManifest(run, inventory, prepared.artifactBundle);
  const approved = expandPublicationEvidenceSelection({
    trustedEvidenceManifest: manifest,
    evidenceManifest: inventory,
    selectedEvidenceKeys: prepared.selectedEvidenceKeys ?? [],
  });
  const selectedEvidenceKeys = params.selectedEvidenceKeys ?? approved;
  const allowed = new Set(approved.map((key) => resolveSelectedEvidenceRef(key, inventory)?.path));
  for (const key of selectedEvidenceKeys) {
    const ref = resolveSelectedEvidenceRef(key, inventory);
    if (!ref || !allowed.has(ref.path))
      throw new Error(`Evidence refresh refused: selection was not approved (${key}).`);
  }
  const selection = {
    selectedEvidenceKeys,
    evidenceManifest: inventory,
    trustedEvidenceManifest: manifest,
  };
  const vars = await loadProjectVars(run.project);
  const ciRepo = vars.projectJson.ci?.repo;
  if (!ciRepo || !getProjectField(vars.projectJson, 'artifacts_repo')) {
    throw new Error('Published evidence requires configured PR and artifacts repositories');
  }
  if (adoption && ciRepo.toLowerCase() !== adoption.repository.toLowerCase())
    throw new Error('Configured repository no longer matches the publication attestation');
  const readPr = async (): Promise<PublishedPrDescription> => {
    const result = await ghRequest(
      [
        'pr',
        'view',
        String(run.prNumber),
        '--repo',
        ciRepo,
        '--json',
        'number,url,headRepository,body,title,headRefName,headRefOid,state',
      ],
      { force: true },
    );
    return JSON.parse(result.stdout) as PublishedPrDescription;
  };
  const assertAdoptedTarget = (facts: PublishedPrDescription) => {
    if (!adoption) return;
    const ref = parseGitHubPullUrl(facts.url);
    if (
      !ref ||
      ref.repo.toLowerCase() !== adoption.repository.toLowerCase() ||
      ref.number !== adoption.prNumber ||
      facts.number !== adoption.prNumber ||
      facts.headRepository?.nameWithOwner.toLowerCase() !== adoption.repository.toLowerCase() ||
      facts.headRefOid !== adoption.headSha ||
      facts.headRefName !== adoption.observedBranch ||
      !['OPEN', 'MERGED'].includes(facts.state)
    )
      throw new Error(
        'Live PR no longer matches the exact attested publication head and repository',
      );
  };
  const before = await readPr();
  assertPublicationTextSafe(before.title, before.body);
  if (!run.branch || before.headRefName !== run.branch || before.state === 'CLOSED') {
    throw new Error('Published PR no longer matches the run branch');
  }
  assertAdoptedTarget(before);
  assertCurrent();
  await verifyFrozenPublicationEvidence(
    run,
    inventory,
    selectedEvidenceKeys,
    prepared.artifactBundle,
  );
  const { artifactUrls, selectedEvidenceKeys: expanded } = await publishSelectedEvidence(
    run,
    run.prNumber,
    selection,
    prepared.artifactBundle,
  );
  if (!expanded.length) throw new Error('No local visual evidence is available to refresh');
  assertCurrent();
  const postedBody = await postProcessPRBody(run, ciRepo, run.prNumber, artifactUrls, expanded, {
    failOnError: true,
    baseBody: adoption ? before.body : withEvidenceAttestation(run, before.body),
    ...(adoption
      ? {
          adoptedEvidence: {
            receipt: adoption,
            prepared,
            previousBody: payload.currentDescription?.body,
          },
        }
      : {}),
    checkAuthorChecklist: false,
    evidenceManifest: manifest,
    validateBody: async () => {
      await verifyFrozenPublicationEvidence(run, inventory, expanded, prepared.artifactBundle);
      const current = await readPr();
      assertAdoptedTarget(current);
      assertCurrent();
      if (current.headRefOid !== before.headRefOid || current.body !== before.body) {
        throw new Error(
          'Published PR changed during evidence refresh; retry against its current state',
        );
      }
    },
  });
  if (postedBody === null) throw new Error('Published evidence body was not posted');
  const publishedAt = new Date().toISOString();
  const committed = await recordPublishedDescription(
    run.id,
    decision.id,
    { draftTitle: before.title, draftBody: postedBody },
    publishedAt,
    { assertCurrent },
  );
  // Match adoption: historical delivery must not re-enter live execution projections.
  if (!committed.archivedAt) emit(Events.RUN_UPDATED, { run: committed });
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
