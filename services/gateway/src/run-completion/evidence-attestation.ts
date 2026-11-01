import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  evidenceAttestationAvailable,
  type EvidencePolicyAttestation,
  isEvidenceAttestationApprover,
  isEvidencePolicyReason,
  isValidEvidenceAttestationReason,
  markdownFence,
  type ReadyGatePrPackage,
  type Run,
  type RunDecision,
  sameEvidenceAttestationApprover,
} from '@farmslot/protocol';

import { latestResolvedHumanGateDecision } from '../run-engine/decision-replay.js';
import { validatePackageApprovalSelection } from '../run-engine/gate-policy.js';
import { buildReviewSummary } from '../run-engine/gate-summary.js';

import { plain } from './inert-text.js';
import { replaceMarkdownSection } from './publication-artifacts.js';
import { withPublicationReceipt } from './publication-details.js';

export function assertEvidenceAttestationReceipt(
  run: Run,
  decision: RunDecision | undefined,
  prepared: ReadyGatePrPackage,
): EvidencePolicyAttestation | undefined {
  if (!decision) return undefined;
  const combined =
    decision?.resolvedAction === APPROVE_PUBLISH_UNRESOLVED_ACTION &&
    (decision.evidenceAttestation !== undefined ||
      evidenceAttestationAvailable(
        decision.payload?.kind === 'ready' ? decision.payload.gateReadiness : undefined,
        decision.resolvedAction,
      ));
  if (decision?.resolvedAction !== APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION && !combined)
    return undefined;
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
  if (combined) {
    const approval = decision.publicationApproval;
    if (
      !approval?.acceptedFindings ||
      !approval.approver ||
      approval.packageHash !== receipt.packageHash ||
      approval.headSha !== prepared.headSha ||
      approval.principalId !== receipt.approver.principalId ||
      !sameEvidenceAttestationApprover(approval.approver, receipt.approver)
    )
      throw new Error(
        'The combined approval receipts do not bind the same person and publication package.',
      );
  }
  return receipt;
}

/** One projection and retained receipt feed publication and subsequent refreshes. */
export function withPublicationProvenance(run: Run, body: string): string {
  const decision = latestResolvedHumanGateDecision(run.decisions, true);
  const prepared = decision?.payload?.kind === 'ready' ? decision.payload.prPackage : undefined;
  if (prepared) {
    // Older published bodies kept these generated receipts outside the gallery.
    for (const heading of [
      'Publication approval',
      'Accepted review findings',
      'Evidence policy attestation',
    ]) {
      body = replaceMarkdownSection(body, `## ${heading}`, null);
    }
    const approval = decision?.publicationApproval;
    if (
      approval &&
      (approval.packageHash !== prepared.packageHash ||
        JSON.stringify(approval.visualJudgmentReceiptIds) !==
          JSON.stringify(prepared.visualJudgmentReceiptIds ?? []) ||
        JSON.stringify(approval.claimOverrideReceiptIds) !==
          JSON.stringify(prepared.claimOverrideReceiptIds ?? []))
    )
      throw new Error('The publication approver receipt does not bind the frozen package.');
    const sections = [
      '### Publication approval',
      '',
      approval
        ? `${plain(approval.displayName)} · ${approval.subjectKind} · ${plain(approval.principalId)} · ${approval.approvedAt}\nPackage: \`${approval.packageHash}\`. Visual receipts: ${approval.visualJudgmentReceiptIds.map(plain).join(', ') || 'none'}.`
        : 'Not recorded.',
    ];
    const accepted = approval?.acceptedFindings;
    if (accepted) {
      if (!approval.approver || !approval.reason || !approval.headSha)
        throw new Error('The accepted review findings receipt is incomplete.');
      const section = [
        `Accepted by ${plain(approval.approver.displayName)} (${plain(approval.approver.principalId)}) at ${approval.approvedAt}.`,
        `Head: \`${approval.headSha}\`. Findings digest: \`${accepted.digest}\`.`,
        '',
        'Reason:',
        markdownFence(approval.reason, 'text'),
        '',
        'Accepted findings:',
        ...accepted.findings.map(
          (finding) =>
            `- ${plain(finding.file)}${finding.line ? `:${finding.line}` : ''}: ${plain(finding.description)} (review ${plain(finding.reviewId)})`,
        ),
      ].join('\n');
      sections.push('', '### Accepted review findings', '', section);
    }
    const receipt = assertEvidenceAttestationReceipt(run, decision, prepared);
    if (receipt) {
      const section = [
        `Approved by ${plain(receipt.approver.displayName)} (${plain(receipt.approver.principalId)}) at ${receipt.approvedAt}.`,
        `Package: \`${receipt.packageHash}\`. Decision: \`${receipt.decisionId}\`.`,
        '',
        'Reason:',
        markdownFence(receipt.reason, 'text'),
        '',
        'Waived claim-policy findings:',
        ...receipt.waivedReasons.map((reason) => `- ${plain(reason.message)}`),
        '',
        'Original evidence and verdicts are retained. Integrity, source, CI and review checks remain required.',
      ].join('\n');
      sections.push('', '### Evidence policy attestation', '', section);
    }
    body = withPublicationReceipt(body, sections.join('\n')).trimEnd() + '\n';
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
