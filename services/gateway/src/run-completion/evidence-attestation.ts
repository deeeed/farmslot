import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type EvidencePolicyAttestation,
  isEvidencePolicyReason,
  isValidEvidenceAttestationReason,
  type ReadyGatePrPackage,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { latestResolvedHumanGateDecision } from '../run-engine/decision-replay.js';
import { validatePackageApprovalSelection } from '../run-engine/gate-policy.js';

import { replaceMarkdownSection } from './publication-artifacts.js';

export function assertEvidenceAttestationReceipt(
  run: Run,
  decision: RunDecision | undefined,
  prepared: ReadyGatePrPackage,
): EvidencePolicyAttestation | undefined {
  if (decision?.resolvedAction !== APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION) return undefined;
  const receipt = decision.evidenceAttestation;
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.runId !== run.id ||
    receipt.decisionId !== decision.id ||
    receipt.packageHash !== prepared.packageHash ||
    !isValidEvidenceAttestationReason(receipt.reason) ||
    !receipt.approver?.principalId?.trim() ||
    !receipt.approver.displayName?.trim() ||
    !receipt.approver.credentialId?.trim() ||
    !Number.isFinite(Date.parse(receipt.approvedAt)) ||
    !Array.isArray(receipt.selectedEvidenceKeys) ||
    !receipt.waivedReasons?.length ||
    !receipt.waivedReasons.every(isEvidencePolicyReason)
  ) {
    throw new Error('Evidence attestation does not bind this publication package.');
  }
  validatePackageApprovalSelection(prepared, {
    ...decision,
    selectionData: {
      ...decision.selectionData,
      selectedEvidenceKeys: receipt.selectedEvidenceKeys,
    },
  });
  return receipt;
}

/** One retained receipt feeds initial publication and subsequent refreshes. */
export function withEvidenceAttestation(run: Run, body: string): string {
  const decision = latestResolvedHumanGateDecision(run.decisions, true);
  const prepared = decision?.payload?.kind === 'ready' ? decision.payload.prPackage : undefined;
  if (!prepared) return body;
  const receipt = assertEvidenceAttestationReceipt(run, decision, prepared);
  if (!receipt) return body;
  const plain = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const section = [
    `Approved by ${plain(receipt.approver.displayName)} (${plain(receipt.approver.principalId)}) at ${receipt.approvedAt}.`,
    `Package: \`${receipt.packageHash}\`. Decision: \`${receipt.decisionId}\`.`,
    '',
    ...receipt.reason.split('\n').map((line) => `> ${plain(line)}`),
    '',
    'Waived claim-policy findings:',
    ...receipt.waivedReasons.map((reason) => `- ${plain(reason.message)}`),
    '',
    'Original evidence and verdicts are retained. Integrity, source, CI and review checks remain required.',
  ].join('\n');
  return replaceMarkdownSection(body, '## Evidence policy attestation', section).trimEnd() + '\n';
}
