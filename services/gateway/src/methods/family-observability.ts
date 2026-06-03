import type {
  FamilyObservabilityGetParams,
  FamilyObservabilityGetResult,
  FamilyReportGenerateParams,
  FamilyReportGenerateResult,
} from '@farmslot/protocol';

import { generateFamilyReport } from '../family-observability/report.js';
import { buildFamilyObservabilitySnapshot } from '../family-observability/snapshot.js';

export async function familyObservabilityGet(
  params: FamilyObservabilityGetParams,
): Promise<FamilyObservabilityGetResult> {
  return {
    snapshot: await buildFamilyObservabilitySnapshot(params.familyId, params.project),
  };
}

export async function familyReportGenerate(
  params: FamilyReportGenerateParams,
): Promise<FamilyReportGenerateResult> {
  const snapshot = await buildFamilyObservabilitySnapshot(params.familyId, params.project);
  const report = await generateFamilyReport(snapshot, params.forceRefresh ?? false);
  return { snapshot, report };
}
