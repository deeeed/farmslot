import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  executionTemplateReference,
  listExecutionTemplates,
  projectWorkerTemplateSource,
} from '@farmslot/agent-runtime';
import {
  type EvalExperimentCreateParams,
  type EvalPackageAxes,
  type EvalPackageAxisRef,
  type EvalTrialStartParams,
  type ExecutionTemplateReference,
  type ExecutionTemplateRunMode,
  resolveRunCreateMode,
  type TaskTemplateSelection,
  type TemplateProvenance,
} from '@farmslot/protocol';

import { loadProjectVars } from '../../core/config.js';
import { fileExists } from '../../evals/package-store.js';
import { harnessRoot } from '../../projects/harness-root.js';
import { assertFetchableHarnessRef } from '../../run-engine/eval-harness-lifecycle.js';
import {
  projectUsesExecutionTemplateCatalog,
  readConfiguredExecutionTemplateSnapshot,
} from '../../tasks/execution-template-catalog.js';
import {
  listWorkerTemplateOptions,
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
  executionTemplate?: ExecutionTemplateReference;
  mode?: ExecutionTemplateRunMode;
  missingData: string[];
}> {
  const missingData: string[] = [];
  const projectVars = await loadProjectVars(project);
  const catalog = projectUsesExecutionTemplateCatalog(projectVars);
  if (axes.template?.hash?.trim() && !catalog) {
    return { axes, missingData };
  }
  const fileName = resolveTemplateFileName(taskProfile, axes.template);
  const parsedProjectOwnedTemplate = parseWorkerTemplateFileName(taskProfile, fileName);
  let templatePath = path.join(projectVars.projectTemplatesDir, 'worker', fileName);
  let templateContent: string;
  let templateVariant: string | null = null;
  let templateIsDefault = false;
  let executionTemplate: ExecutionTemplateReference | undefined;
  let taskTemplate: TaskTemplateSelection | undefined;
  if (catalog) {
    const entry = listExecutionTemplates({
      sources: [projectWorkerTemplateSource(project, projectVars.projectTemplatesDir)],
      flow: taskProfile,
    }).find((candidate) => candidate.relativePath === fileName);
    if (!entry)
      throw new Error(`Candidate template is unavailable in the project catalog: ${fileName}`);
    const snapshot = readConfiguredExecutionTemplateSnapshot(projectVars, {
      flow: taskProfile,
      id: entry.id,
      sourceId: entry.sourceId,
      sha256: entry.sha256,
    });
    templatePath = snapshot.entry.path;
    templateContent = snapshot.markdown;
    executionTemplate = executionTemplateReference(snapshot.entry);
    templateVariant = parsedProjectOwnedTemplate?.variant ?? null;
    templateIsDefault = fileName === FLOW_TO_TEMPLATE[taskProfile];
  } else if (parsedProjectOwnedTemplate) {
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
    templateVariant = selectedTemplate.variant ?? null;
    templateIsDefault = selectedTemplate.isDefault;
  } else {
    if (!(await fileExists(templatePath))) {
      missingData.push('template-provenance-missing');
      return { axes, missingData };
    }
    templateContent = await readFile(templatePath, 'utf-8');
  }
  const provenance = await buildTemplateProvenance({
    flowType: taskProfile,
    project,
    templatePath,
    templateName: fileName,
    templateContent,
    templateVariant,
    templateIsDefault,
    role: 'eval-candidate',
  });
  return {
    provenance,
    executionTemplate,
    mode: executionTemplate
      ? resolveRunCreateMode({
          flowType: taskProfile,
          taskTemplateFileName: fileName,
          templateOptions: await listWorkerTemplateOptions(projectVars, taskProfile),
        })
      : undefined,
    templateContent,
    taskTemplate,
    missingData,
    axes: axes.template?.hash?.trim()
      ? axes
      : {
          ...axes,
          template: {
            ...axes.template,
            path: axes.template?.path ?? `templates/worker/${fileName}`,
            name: axes.template?.name ?? fileName.replace(/\.md$/, ''),
            hash: axes.template?.hash ?? provenance.contentHash,
            ref: provenance.projectRepoHeadSha ?? axes.template?.ref,
          },
        },
  };
}
