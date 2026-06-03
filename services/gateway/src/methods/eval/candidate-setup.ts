import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  EvalExperimentCreateParams,
  EvalPackageAxes,
  EvalPackageAxisRef,
  EvalTrialStartParams,
  TaskTemplateSelection,
  TemplateProvenance,
} from '@farmslot/protocol';

import { loadProjectVars } from '../../core/config.js';
import { fileExists } from '../../evals/package-store.js';
import { harnessRoot } from '../../projects/harness-root.js';
import { assertFetchableHarnessRef } from '../../run-engine/eval-harness-lifecycle.js';
import {
  parseWorkerTemplateFileName,
  resolveWorkerTemplateSelection,
} from '../../tasks/worker-template-options.js';
import { buildTemplateProvenance, FLOW_TO_TEMPLATE } from '../../tasks/writer.js';

function axisRefFromString(name: string | undefined): EvalPackageAxisRef | undefined {
  const trimmed = name?.trim();
  return trimmed ? { name: trimmed } : undefined;
}

export function axesWithExecutionDefaults(
  axes: EvalPackageAxes,
  params: Pick<EvalTrialStartParams, 'runner' | 'model'>,
): EvalPackageAxes {
  return {
    ...axes,
    runner: axes.runner ?? axisRefFromString(params.runner),
    model: axes.model ?? axisRefFromString(params.model),
  };
}

function fullSha(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed : undefined;
}

export function harnessLifecycleForAxes(project: string, axes: EvalPackageAxes) {
  const harness = axes.harness;
  if (!harness) return undefined;
  assertFetchableHarnessRef(harness);
  const adapter = harnessAdapterForProject(project, harness);
  const explicitPath = harness.path?.trim();
  const hasRequestedRef = Boolean(harness.ref?.trim() || harness.hash?.trim());
  let source = explicitPath || harness.name?.trim();
  if (!source && hasRequestedRef) source = 'recipe-harness';
  const version = harness.version?.trim();
  return {
    source,
    requestedRef:
      harness.ref ??
      harness.hash ??
      (version && version !== 'mobile' && version !== 'extension' ? version : undefined),
    resolvedSha: fullSha(harness.hash) ?? fullSha(harness.ref),
    adapter,
    manifestPath: adapter ? `${harnessRoot()}/${adapter}/manifest.json` : undefined,
    installStatus: 'pending' as const,
    verifyStatus: 'pending' as const,
    cleanupStatus: 'pending' as const,
  };
}

function harnessAdapterForProject(
  project: string,
  harness: EvalPackageAxisRef,
): string | undefined {
  if (harness.version === 'mobile' || harness.version === 'extension') return harness.version;
  if (project.includes('mobile')) return 'mobile';
  if (project.includes('extension')) return 'extension';
  return harness.name;
}

function resolveTemplateFileName(
  taskProfile: EvalExperimentCreateParams['taskProfile'],
  axis?: EvalPackageAxisRef,
): string {
  const axisPath = axis?.path?.trim();
  if (axisPath) return path.basename(axisPath);
  const axisName = axis?.name?.trim();
  if (axisName?.endsWith('.md')) return path.basename(axisName);
  return FLOW_TO_TEMPLATE[taskProfile] ?? `${taskProfile}.md`;
}

export async function resolveCandidateTemplateProvenance(
  project: string,
  taskProfile: EvalExperimentCreateParams['taskProfile'],
  axes: EvalPackageAxes,
): Promise<{
  axes: EvalPackageAxes;
  provenance?: TemplateProvenance;
  templateContent?: string;
  taskTemplate?: TaskTemplateSelection;
  missingData: string[];
}> {
  const missingData: string[] = [];
  if (axes.template?.hash?.trim()) {
    return { axes, missingData };
  }
  const fileName = resolveTemplateFileName(taskProfile, axes.template);
  const projectVars = await loadProjectVars(project);
  const parsedProjectOwnedTemplate = parseWorkerTemplateFileName(taskProfile, fileName);
  let templatePath = path.join(projectVars.projectTemplatesDir, 'worker', fileName);
  let templateContent: string;
  let provenance: TemplateProvenance;
  let taskTemplate: TaskTemplateSelection | undefined;
  if (parsedProjectOwnedTemplate) {
    if (!(await fileExists(templatePath))) {
      missingData.push('template-provenance-missing');
      return { axes, missingData };
    }
    const selectedTemplate = await resolveWorkerTemplateSelection(projectVars, taskProfile, {
      fileName,
    });
    templatePath = selectedTemplate.templatePath;
    templateContent = selectedTemplate.content;
    taskTemplate = { fileName: selectedTemplate.fileName, variant: selectedTemplate.variant };
    provenance = await buildTemplateProvenance({
      flowType: taskProfile,
      project,
      templatePath,
      templateName: selectedTemplate.fileName,
      templateContent,
      templateVariant: selectedTemplate.variant,
      templateIsDefault: selectedTemplate.isDefault,
      role: 'eval-candidate',
    });
  } else {
    if (!(await fileExists(templatePath))) {
      missingData.push('template-provenance-missing');
      return { axes, missingData };
    }
    templateContent = await readFile(templatePath, 'utf-8');
    provenance = await buildTemplateProvenance({
      flowType: taskProfile,
      project,
      templatePath,
      templateName: fileName,
      templateContent,
      templateVariant: null,
      templateIsDefault: false,
      role: 'eval-candidate',
    });
  }
  return {
    provenance,
    templateContent,
    taskTemplate,
    missingData,
    axes: {
      ...axes,
      template: {
        ...axes.template,
        path: axes.template?.path ?? `templates/worker/${fileName}`,
        name: axes.template?.name ?? fileName.replace(/\.md$/, ''),
        hash: provenance.contentHash,
        ref: provenance.projectRepoHeadSha ?? axes.template?.ref,
      },
    },
  };
}
