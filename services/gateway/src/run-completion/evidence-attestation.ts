import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type EvidencePolicyAttestation,
  isEvidenceAttestationApprover,
  isEvidencePolicyReason,
  isValidEvidenceAttestationReason,
  type ReadyGatePrPackage,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { latestResolvedHumanGateDecision } from '../run-engine/decision-replay.js';
import { validatePackageApprovalSelection } from '../run-engine/gate-policy.js';
import { buildReviewSummary } from '../run-engine/gate-summary.js';

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
    !isEvidenceAttestationApprover(receipt.approver) ||
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

/** One projection and retained receipt feed publication and subsequent refreshes. */
export function withPublicationProvenance(run: Run, body: string): string {
  const decision = latestResolvedHumanGateDecision(run.decisions, true);
  const prepared = decision?.payload?.kind === 'ready' ? decision.payload.prPackage : undefined;
  if (prepared) {
    const approval = decision?.publicationApproval;
    const plain = (value: string) =>
      value
        .replace(/[\r\n]+/gu, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/([`*_[\]\\])/gu, '\\$1');
    if (
      approval &&
      (approval.packageHash !== prepared.packageHash ||
        JSON.stringify(approval.visualJudgmentReceiptIds) !==
          JSON.stringify(prepared.visualJudgmentReceiptIds ?? []) ||
        JSON.stringify(approval.claimOverrideReceiptIds) !==
          JSON.stringify(prepared.claimOverrideReceiptIds ?? []))
    )
      throw new Error('The publication approver receipt does not bind the frozen package.');
    body = replaceMarkdownSection(
      body,
      '## Publication approval',
      approval
        ? `${plain(approval.displayName)} · ${approval.subjectKind} · ${plain(approval.principalId)} · ${approval.approvedAt}\nPackage: \`${approval.packageHash}\`. Visual receipts: ${approval.visualJudgmentReceiptIds.map(plain).join(', ') || 'none'}.`
        : 'Not recorded.',
    );
    const receipt = assertEvidenceAttestationReceipt(run, decision, prepared);
    if (receipt) {
      const fence = '`'.repeat(
        Math.max(3, ...[...receipt.reason.matchAll(/`+/g)].map((match) => match[0].length + 1)),
      );
      const section = [
        `Approved by ${plain(receipt.approver.displayName)} (${plain(receipt.approver.principalId)}) at ${receipt.approvedAt}.`,
        `Package: \`${receipt.packageHash}\`. Decision: \`${receipt.decisionId}\`.`,
        '',
        'Reason:',
        `${fence}text`,
        receipt.reason,
        fence,
        '',
        'Waived claim-policy findings:',
        ...receipt.waivedReasons.map((reason) => `- ${plain(reason.message)}`),
        '',
        'Original evidence and verdicts are retained. Integrity, source, CI and review checks remain required.',
      ].join('\n');
      body =
        replaceMarkdownSection(body, '## Evidence policy attestation', section).trimEnd() + '\n';
    }
    body = body.trimEnd() + '\n';
  }
  const noReviewNotice = [
    '<!-- farmslot-code-review:start -->',
    'Code review: No code review ran.',
    '<!-- farmslot-code-review:end -->',
  ].join('\n');
  if (buildReviewSummary(run).noCodeReview) {
    if (!body.includes(noReviewNotice)) body = `${body.trimEnd()}\n\n${noReviewNotice}\n`;
  } else if (body.includes(noReviewNotice)) {
    body = body.replace(noReviewNotice, '').trimEnd() + '\n';
  }
  return body;
}
