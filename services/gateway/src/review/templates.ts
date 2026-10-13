import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_BRANCH,
  DEFAULT_TASK_DIR,
  type EvidenceManifest,
  type ReviewIssue,
  type ReviewMode,
  type ReviewValidationDepth,
  type Run,
} from '@farmslot/protocol';
import { expandSourceBindings } from '@farmslot/slot-config';

import {
  getOrchestratorTaskRoot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  resolveProjectRuntimeDir,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import {
  assertNoUnknownPlaceholders,
  expandTemplate,
  expandTemplateWithReservedLast,
  knownTemplatePlaceholders,
} from '../core/hooks.js';
import { shellQuote } from '../core/tmux.js';
import { projectWorkerTemplatePath } from '../core/worker-templates.js';
import { remoteBranchRefspec } from '../methods/slot/slot-tracking.js';
import { buildReviewPlanningBrief } from '../run-engine/review-artifacts.js';
import { publicationBaseForRun } from '../run-engine/stack-base.js';
import { getRun } from '../runs/store.js';
import { REVIEW_FIX_CHECKLIST_TARGET } from '../tasks/checklist-target.js';
import { resolveConfiguredExecutionTemplateForSlot } from '../tasks/execution-template-catalog.js';

import {
  buildDescriptionCheckSection,
  type DescriptionCheckFinding,
  descriptionCheckFindings,
} from './description-check.js';
import { parseReviewMode } from './session-mode.js';
import {
  renderReviewTemplatePaths,
  reviewFeedbackFileList,
  reviewFeedbackPathsForFix,
  type ReviewTemplatePaths,
} from './template-paths.js';

interface ReviewConfig {
  enabled: boolean;
  runner?: string;
  model?: string;
  effort?: string;
  max_retries?: number;
  review_timeout_min?: number;
  mode?: ReviewMode;
}

async function readReviewArtifact(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  file: string,
): Promise<string | null> {
  const quoted = shellQuote(file);
  const result = await execOnSlot(
    vars,
    `if [ -f ${quoted} ]; then cat ${quoted}; else exit 66; fi`,
    { cwd: '/', timeout: 30_000 },
  );
  if (result.exitCode === 66) return null;
  if (result.exitCode !== 0) throw new Error(`Review artifact read failed: ${result.stderr}`);
  return result.stdout;
}

const REMOTE_FARMSLOT_DIR = '~/farmslot-node';
/** Diffs past this size are cut for the pre-check scan; the reviewer still reads them whole. */
const PRE_CHECK_DIFF_BYTES = 5_000_000;

/**
 * Reads the final description, commit subjects, diff and evidence manifest on
 * the slot and scans them. Never fails the review: a read that does not work
 * becomes a "not run" line the reviewer sees.
 */
async function runDescriptionPreCheck(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  baseBranch: string,
  evidenceManifest: EvidenceManifest | null,
): Promise<DescriptionCheckFinding[] | { unavailable: string }> {
  const base = `origin/${baseBranch}`;
  const inRepo = (command: string) =>
    execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && ${command}`, { timeout: 60_000 });
  try {
    // A failed fetch still leaves the remote-tracking ref the checkout has.
    await inRepo(`git fetch origin ${shellQuote(remoteBranchRefspec(baseBranch))}`);
    // Through a file, not a pipe: `head` would hide a failing diff.
    const diff = await inRepo(
      `t=$(mktemp) && { git diff --no-ext-diff --no-textconv ${shellQuote(`${base}...HEAD`)} > "$t"; s=$?; head -c ${PRE_CHECK_DIFF_BYTES} "$t"; rm -f "$t"; exit $s; }`,
    );
    const log = await inRepo(`git log --format=%s ${shellQuote(`${base}..HEAD`)}`);
    if (diff.exitCode !== 0 || log.exitCode !== 0)
      return { unavailable: `could not read the diff against ${base}` };
    const description = await inRepo(`cat ${shellQuote(`${taskDir}/artifacts/pr-description.md`)}`);
    return descriptionCheckFindings({
      description: description.exitCode === 0 ? description.stdout : null,
      commitSubjects: log.stdout.split('\n').filter((line) => line.trim()),
      diff: diff.stdout,
      evidenceManifest,
    });
  } catch (err) {
    return { unavailable: (err as Error).message.split('\n')[0]!.slice(0, 200) };
  }
}

/** The section every review document ends with, whatever template it came from. */
async function descriptionCheckSection(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  run: NonNullable<ReturnType<typeof getRun>>,
  projectJson: Awaited<ReturnType<typeof loadProjectVars>>['projectJson'] | undefined,
): Promise<string> {
  const baseBranch = await publicationBaseForRun(
    run,
    projectJson ? getProjectField(projectJson, 'default_branch') : undefined,
  );
  const { resolvePublicationManifest } = await import('../run-completion/publication-artifacts.js');
  let publication;
  let selectionError: string | undefined;
  try {
    publication = await resolvePublicationManifest(
      taskDir,
      {
        readText: (file) => readReviewArtifact(vars, file),
      },
      undefined,
      run.recordedEvidenceContractVersion ?? 0,
    );
  } catch (error) {
    // An unavailable pre-check still produces the review document with an explicit diagnostic.
    selectionError = error instanceof Error ? error.message : String(error);
  }
  return buildDescriptionCheckSection({
    repo: vars.remoteRepo,
    taskDir,
    baseBranch,
    manifestPath: publication
      ? path.join(taskDir, publication.sourcePath)
      : selectionError
        ? null
        : undefined,
    preCheck: selectionError
      ? { unavailable: selectionError }
      : await runDescriptionPreCheck(vars, taskDir, baseBranch, publication?.manifest ?? null),
  });
}

export async function expandReviewTemplate(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  runId: string,
  validationDepth: ReviewValidationDepth,
  lanePaths: ReviewTemplatePaths = {
    checklist: 'REVIEW.md',
    signal: 'REVIEW-SIGNAL.json',
    feedback: 'artifacts/review-feedback.md',
  },
): Promise<string> {
  // Read template from project
  const run = getRun(runId);
  const project = run?.project;
  if (!project) throw new Error(`Cannot expand review template without a project for run ${runId}`);

  const configured = await loadProjectVars(project);
  let template: string;
  let bindingSection = '';
  const references = configured.projectJson.review?.execution_templates;
  if (references !== undefined) {
    if (
      !references ||
      ['static-code', 'full-live'].some(
        (depth) =>
          typeof references[depth as ReviewValidationDepth] !== 'string' ||
          !references[depth as ReviewValidationDepth].trim(),
      )
    )
      throw new Error(
        'Review execution_templates must select both static-code and full-live templates',
      );
    const selected = resolveConfiguredExecutionTemplateForSlot(configured, {
      flow: 'review',
      platform: vars.platform,
      runMode: 'autonomous',
      explicitId: references[validationDepth],
      ...(run.domain ? { explicitDomain: run.domain } : {}),
      ...(vars.domain ? { slotDomain: vars.domain } : {}),
    });
    if (!selected.reference.labels.includes(`review-depth:${validationDepth}`))
      throw new Error(`Review template must declare review-depth:${validationDepth}`);
    let provenanceArtifact: string | undefined;
    if (run.taskFile) {
      const content = `${JSON.stringify({ executionTemplate: selected.reference }, null, 2)}\n`;
      provenanceArtifact = `artifacts/review-template-${createHash('sha256').update(content).digest('hex')}.json`;
      const destination = path.join(path.dirname(run.taskFile), provenanceArtifact);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await writeFile(destination, content, { flag: 'wx' });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(destination, 'utf8')) !== content
        )
          throw error;
      }
    }
    const bindings = {
      runId,
      taskDir,
      repositoryPath: vars.remoteRepo,
      validationDepth,
      executionTemplate: selected.reference,
      ...(provenanceArtifact ? { retainedProvenanceArtifact: provenanceArtifact } : {}),
      checklistFile: lanePaths.checklist,
      signalFile: lanePaths.signal,
      feedbackFile: lanePaths.feedback,
    };
    template = selected.markdown;
    bindingSection = `
## Review execution bindings

\`\`\`json
${JSON.stringify(bindings, null, 2)}
\`\`\`

Use the task's mark wrapper for this reviewer checklist. Preserve the parent worker's CHECKLIST.md. The gateway retains the indexed provenance artifact and owns session termination.
`;
  } else {
    try {
      const depthTemplatePath = await projectWorkerTemplatePath(
        project,
        `review.${validationDepth}.md`,
      );
      const fallbackTemplatePath = await projectWorkerTemplatePath(project, 'review.md');
      try {
        template = await readFile(depthTemplatePath, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new Error(`Failed to read ${depthTemplatePath}: ${(err as Error).message}`);
        }
        template = await readFile(fallbackTemplatePath, 'utf-8');
      }
    } catch (err) {
      throw new Error(
        `Review template not found for project ${project} (${validationDepth}): ${(err as Error).message}`,
      );
    }
  }

  template = expandSourceBindings(template, configured.sourceContext);

  // Resolve runtimeDir and mobile reference repo path from project vars
  template = renderReviewTemplatePaths(template, lanePaths);
  const runtimeDir = await resolveProjectRuntimeDir(project);
  let pv: Awaited<ReturnType<typeof loadProjectVars>> | null = null;
  let mobileRepo = '';
  try {
    pv = await loadProjectVars(project);
    const parentDir = path.dirname(vars.remoteRepo);
    const refName = pv?.projectJson.reference_repos?.mobile?.local_name;
    const candidates = refName
      ? [path.join(parentDir, refName), path.join(parentDir, refName.replace(/-ref$/, '-1'))]
      : [];
    for (const c of candidates) {
      if (existsSync(c)) {
        mobileRepo = c;
        break;
      }
    }
  } catch (err) {
    // Recoverable: runtimeDir defaults to '.agent', mobileRepo stays empty.
    console.warn(`[review] project vars fallback for ${project}: ${(err as Error).message}`);
  }

  // Expand {{VAR}} placeholders
  const { farmslotRoot } = await import('../fleet/state.js');
  const farmslotDir = isLocal(vars.host, vars.machine) ? farmslotRoot : REMOTE_FARMSLOT_DIR;
  const replacements: Record<string, string> = {
    TASK_DIR: taskDir,
    REPO: vars.remoteRepo,
    PLATFORM: vars.platform || 'ios',
    WATCHER_PORT: vars.resourceVars.port ?? '',
    CDP_PORT: vars.resourceVars.cdp_port ?? '',
    RUNTIME_DIR: runtimeDir,
    TICKET: run?.ticketOrPr ?? '',
    SESSION: vars.session,
    MOBILE_REPO: mobileRepo,
    VALIDATION_DEPTH: validationDepth,
    // Same value worker TASK.md templates get.
    DEFAULT_BRANCH: (pv && getProjectField(pv.projectJson, 'default_branch')) || DEFAULT_BRANCH,
    FARMSLOT_DIR: farmslotDir,
    farmslot_dir: farmslotDir,
  };

  assertNoUnknownPlaceholders(
    template,
    [...Object.keys(replacements), ...knownTemplatePlaceholders(vars, pv ?? undefined)],
    `Review template for ${project} (${validationDepth})`,
  );
  // Explicit values first so the existence-checked MOBILE_REPO wins over the
  // hooks pass's unchecked reference-repo path; all values here are paths/
  // ports/ids, so re-expanding them in the second pass is a non-issue.
  let expanded = template;
  for (const [key, val] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, val);
  }
  // Second pass: slot resources, project.json vars, reference repos — same
  // coverage as CI-fix task rendering, so templates can use {{recipe_*}} etc.
  expanded = expandTemplate(expanded, vars, pv ?? undefined);
  // Reviewers get the worker's frozen related-context snapshot, not a fresh
  // derivation: a prerequisite that moved since dispatch must be detectable.
  const planningBrief = await buildReviewPlanningBrief(run?.taskFile ?? null, taskDir);
  const check = await descriptionCheckSection(vars, taskDir, run, pv?.projectJson);
  return `${expanded.trimEnd()}${bindingSection}\n${planningBrief.trimEnd()}\n\n${check}\n`;
}

export async function expandReviewFixTemplate(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  run: Run,
  issues: ReviewIssue[],
): Promise<string> {
  // Format issues as bullet list for template insertion
  const issueLines = issues
    .map((i) => {
      const loc = i.line ? `${i.file}:${i.line}` : i.file;
      return `- **${loc}** — ${i.description}`;
    })
    .join('\n');

  // Read and expand the review-fix template
  let template: string;
  try {
    const templatePath = await projectWorkerTemplatePath(run.project, 'review-fix.md');
    template = await readFile(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Review fix template not found for project ${run.project}: ${(err as Error).message}`,
    );
  }

  const runtimeDir = await resolveProjectRuntimeDir(run.project);
  const pv = await loadProjectVars(run.project);

  const replacements: Record<string, string> = {
    CI_PARITY_CHECKLIST: REVIEW_FIX_CHECKLIST_TARGET.checklist,
    TASK_DIR: taskDir,
    REPO: vars.remoteRepo,
    TICKET: run?.ticketOrPr ?? '',
    ISSUES: issueLines,
    REVIEW_FEEDBACK_FILES: reviewFeedbackFileList(taskDir, reviewFeedbackPathsForFix(run, taskDir)),
    RUNTIME_DIR: runtimeDir,
    DEFAULT_BRANCH: getProjectField(pv.projectJson, 'default_branch') || DEFAULT_BRANCH,
  };

  template = expandSourceBindings(template, pv.sourceContext);
  assertNoUnknownPlaceholders(
    template,
    [...Object.keys(replacements), ...knownTemplatePlaceholders(vars, pv)],
    `Review fix template for ${run.project}`,
  );
  // Hooks pass covers {{farmslot_dir}}, {{SLOT_ID}}, {{recipe_*}} beyond the
  // explicit set; explicit values land last so reviewer-authored ISSUES text
  // is never re-expanded and a colliding var cannot consume the placeholder.
  const hasFeedbackList = template.includes('{{REVIEW_FEEDBACK_FILES}}');
  template = template.replaceAll(
    '{{TASK_DIR}}/artifacts/review-feedback.md',
    'the reviewer lane feedback files',
  );
  const feedbackSection = hasFeedbackList
    ? ''
    : `## Reviewer lane feedback\n\nRead every lane's feedback before applying the findings.\n\n${replacements.REVIEW_FEEDBACK_FILES}\n\n`;
  return feedbackSection + expandTemplateWithReservedLast(template, vars, pv, replacements);
}

export async function getReviewConfig(project: string): Promise<ReviewConfig> {
  const pv = await loadProjectVars(project);
  const raw = pv.projectJson.review;
  if (!raw) return { enabled: false };
  return {
    enabled: raw.enabled === true,
    runner: raw.runner,
    model: raw.model,
    effort: raw.effort,
    max_retries: raw.max_retries,
    review_timeout_min: raw.review_timeout_min,
    mode: parseReviewMode(raw.mode),
  };
}

export async function resolveWorkerTaskDir(
  _vars: Awaited<ReturnType<typeof loadSlotVars>>,
  project: string,
  taskFile: string | null,
): Promise<string | null> {
  if (!taskFile) return null;
  const pv = await loadProjectVars(project).catch(() => null);
  const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;

  const orchRoot = pv ? getOrchestratorTaskRoot(project, pv.projectJson) : null;
  const taskRelDir = orchRoot ? resolveTaskRelDir(taskFile, orchRoot) : null;
  if (!taskRelDir) return null;
  return `${taskDirName}/${taskRelDir}`;
}
