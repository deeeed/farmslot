import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import { recordedEvidenceClosureIdentity } from '@farmslot/protocol';

export const nativeVisualSupportFiles = {
  'TASK.md': 'Unchanged retained visual fixture; no worker and no new recording.\n',
  'artifacts/latest-valid-recipe-run.json': JSON.stringify({
    version: 1,
    relativeArtifactRoot: 'recipe-runs/native-visual-fixture',
  }),
  'artifacts/report.md':
    '# Owned visual judgment fixture\n\nThis is an unchanged retained Sources recording used only to exercise the Companion judgment controls. It does not claim this recording ran during the current progress proof or certify current farm state.\n',
};

/** Read-only qualification shared by DRY preflight and actual fixture admission. */
export async function inspectNativeVisualSource(sourceDirectory) {
  assert(
    sourceDirectory,
    'Choose an existing real recorded-evidence closure before the one device attempt',
  );
  const source = await realpath(sourceDirectory);
  const read = await readRecordedEvidencePackage(source);
  assert(
    read.checks.every((check) => check.status === 'pass'),
    JSON.stringify(read.checks),
  );
  const validation = validateRecordedEvidencePackage(read.input);
  assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
  const claim = deriveReviewedRecipeClaims(read.input).find(
    (row) =>
      row.id === 'source-notification' &&
      row.proofMode === 'visual' &&
      row.verdict === 'awaiting-review' &&
      row.timing === 'measured' &&
      row.assertionIndices.length &&
      row.moments.length,
  );
  assert(
    claim,
    'The selected retained execution must contain its real eligible visual expectation',
  );
  assert.equal(read.input.claims.recording.status, 'complete');
  let bytes = 0;
  for (const file of read.input.artifactPaths) {
    assert(
      !path.isAbsolute(file) &&
        file.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..'),
    );
    const actual = await realpath(path.join(source, file));
    const relative = path.relative(source, actual);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const raw = await readFile(actual);
    assert.equal(
      createHash('sha256').update(raw).digest('hex'),
      read.input.artifactDigests[file].replace(/^sha256:/, ''),
    );
    if (/\.(mp4|mov)$/i.test(file)) assert(raw.subarray(4, 8).equals(Buffer.from('ftyp')));
    bytes += raw.length;
    assert(bytes <= 8 * 1024 * 1024);
  }
  return { source, read, claim };
}

/** Admit exactly the unchanged closure the headless resolver inspected. */
export async function prepareNativeVisualFixture({
  sourceRoot,
  sourceDirectory,
  taskDir,
  runId,
  rpc,
  owner,
}) {
  assert(owner, 'Fixture writes require an ownership journal');
  const { source, read, claim } = await inspectNativeVisualSource(sourceDirectory);
  const relativeRoot = 'artifacts/recipe-runs/native-visual-fixture';
  const destination = path.join(taskDir, relativeRoot);
  const inventory = [];
  let bytes = 0;
  for (const file of read.input.artifactPaths) {
    assert(
      !path.isAbsolute(file) &&
        file.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..'),
      'Artifact inventory paths must stay relative and normalized',
    );
    const sourceFile = await realpath(path.resolve(source, file));
    const relative = path.relative(source, sourceFile);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const raw = await readFile(sourceFile);
    const hash = createHash('sha256').update(raw).digest('hex');
    assert.equal(hash, read.input.artifactDigests[file].replace(/^sha256:/, ''));
    if (/\.(mp4|mov)$/i.test(file))
      assert(
        raw.subarray(4, 8).equals(Buffer.from('ftyp')),
        'Retain actual media bytes, never the text-only unit-test video',
      );
    bytes += raw.length;
    assert(bytes <= 8 * 1024 * 1024, 'The owned visual fixture must remain small');
    const target = path.join(destination, file);
    await owner.write(target, raw);
    inventory.push({
      path: `${relativeRoot}/${file}`,
      purpose:
        path.basename(file) === 'evidence-manifest.json' ? 'evidence-manifest-source' : 'evidence',
      sha256: hash,
      sizeBytes: raw.length,
    });
  }
  const copied = await readRecordedEvidencePackage(destination);
  assert(copied.checks.every((check) => check.status === 'pass'));
  assert.equal(validateRecordedEvidencePackage(copied.input).status, 'valid');
  assert.equal(
    recordedEvidenceClosureIdentity(copied.input),
    recordedEvidenceClosureIdentity(read.input),
  );
  const files = Object.fromEntries(
    Object.entries(nativeVisualSupportFiles).filter(([file]) => file !== 'TASK.md'),
  );
  for (const [file, value] of Object.entries(files)) {
    await owner.write(path.join(taskDir, file), value);
    inventory.push({
      path: file,
      purpose: file.endsWith('report.md') ? 'report' : 'evidence',
      sha256: createHash('sha256').update(value).digest('hex'),
      sizeBytes: Buffer.byteLength(value),
    });
  }
  const { outputManifestDigest } = await import(
    path.join(sourceRoot, 'services/gateway/src/run-completion/output.ts')
  );
  const manifestDigest = outputManifestDigest(inventory);
  const principals = await rpc('principal.list');
  const service = principals.principals.find((entry) => entry.id === 'test-automation');
  assert(service?.subject.type === 'service' && (service.generation ?? 0) === 0);
  const sourceLedgerDigest = createHash('sha256')
    .update(await readFile(path.join(source, 'acceptance-status.json')))
    .digest('hex');
  const person = (
    await rpc('principal.create', {
      subject: { type: 'person', displayName: `Owned native proof delegator ${runId.slice(0, 8)}` },
      roles: [],
    })
  ).principal;
  const decisionId = `visual-${runId}`;
  return {
    claimId: claim.id,
    recipeRunId: read.input.claims.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(read.input),
    sourceDirectory: source,
    sourceLedgerDigest,
    copiedLedger: path.join(destination, 'acceptance-status.json'),
    serviceId: service.id,
    delegatorId: person.id,
    decisionId,
    inventory,
    projectPolicy: { delegatedReviewerPrincipalIds: [service.id], delegatorPrincipalId: person.id },
    output: {
      workerFinished: false,
      capturedAt: new Date().toISOString(),
      manifestDigest,
      artifactManifest: inventory,
      reportPath: 'artifacts/report.md',
    },
    decision: {
      id: decisionId,
      type: 'engine_output_review',
      title: 'Owned retained visual fixture',
      description: 'Exercise only the exact retained recording judgment.',
      actions: [],
      createdAt: new Date().toISOString(),
      payload: {
        kind: 'output-review',
        manifestDigest,
        reportPath: 'artifacts/report.md',
        visualJudgmentReceiptIds: [],
      },
    },
  };
}

/** Read the gateway independently of Companion to prove a real accepted receipt and projected verdict. */
export async function assertNativeVisualReceipt({
  rpc,
  runId,
  fixture,
  verdict,
  reason,
  previousReceiptCount,
}) {
  const { run } = await rpc('run.get', { runId });
  const matching = (run.visualJudgmentReceipts ?? []).filter(
    (receipt) => receipt.claimId === fixture.claimId && receipt.recipeRunId === fixture.recipeRunId,
  );
  assert.equal(
    matching.length,
    previousReceiptCount + 1,
    'Exactly one actual UI submission must produce one new receipt',
  );
  const receipt = matching.at(-1);
  assert.equal(receipt.verdict, verdict);
  assert.equal(receipt.reason, reason);
  assert.equal(receipt.kind, 'lead-agent-reviewed');
  assert.equal(receipt.approver.principalId, fixture.serviceId);
  assert.equal(receipt.delegation.principalId, fixture.delegatorId);
  assert.equal(receipt.closureIdentity, fixture.closureIdentity);
  assert(receipt.reviewedFiles.length > 0);
  const snapshot = await rpc('run.recipeRunsForRun', {
    runId,
    includeRecordedEvidence: true,
    decisionId: fixture.decisionId,
    evidenceSnapshotHash: fixture.output.manifestDigest,
    recordedRecipeRunId: fixture.recipeRunId,
  });
  const observed = snapshot.recordedEvidence;
  assert.deepEqual(observed.errors, []);
  assert.equal(observed.visualReviewContext.decisionId, fixture.decisionId);
  assert.equal(recordedEvidenceClosureIdentity(observed.input), fixture.closureIdentity);
  const claims = deriveReviewedRecipeClaims(observed.input, observed.visualReviewAuthority);
  assert.equal(
    claims.find((claim) => claim.id === fixture.claimId)?.verdict,
    verdict === 'confirmed' ? 'proven' : 'failed',
  );
  assert(
    run.decisions
      .find((decision) => decision.id === fixture.decisionId)
      .payload.visualJudgmentReceiptIds.includes(receipt.id),
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(fixture.copiedLedger))
      .digest('hex'),
    fixture.sourceLedgerDigest,
    'A judgment must preserve the original retained claim ledger',
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(path.join(fixture.sourceDirectory, 'acceptance-status.json')))
      .digest('hex'),
    fixture.sourceLedgerDigest,
    'A judgment must preserve the original source ledger',
  );
  return {
    receiptId: receipt.id,
    verdict: receipt.verdict,
    kind: receipt.kind,
    claimId: receipt.claimId,
    recipeRunId: receipt.recipeRunId,
    projectedVerdict: verdict === 'confirmed' ? 'proven' : 'failed',
    reviewedFiles: receipt.reviewedFiles,
  };
}
