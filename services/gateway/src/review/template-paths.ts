import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import type { ChecklistTarget } from '@farmslot/protocol/checklist-target';

export interface ReviewTemplatePaths extends ChecklistTarget {
  /** Feedback path relative to the task directory. */
  feedback: string;
}

export function reviewerChecklistBasename(contextId: string): string {
  return `REVIEW.${contextId}.md`;
}

export function reviewerFeedbackRelPath(contextId: string): string {
  return `artifacts/review-feedback.${contextId}.md`;
}

export function reviewTemplateBindings(paths: ReviewTemplatePaths): Record<string, string> {
  return {
    REVIEW_CHECKLIST: paths.checklist,
    REVIEW_SIGNAL: paths.signal,
    REVIEW_FEEDBACK: paths.feedback,
  };
}

/** Old pack checklist/signal names address the same allocated reviewer lane. */
export function renderReviewTemplatePaths(template: string, paths: ReviewTemplatePaths): string {
  let rendered = template;
  for (const [key, value] of Object.entries(reviewTemplateBindings(paths))) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered
    .replace(
      /(^|[^\w./-]|\{\{TASK_DIR\}\}\/)(?:SELF-REVIEW|REVIEW)-SIGNAL\.json(?![\w./-])/g,
      (_match, prefix: string) => `${prefix}${paths.signal}`,
    )
    .replace(
      /(^|[^\w./-]|\{\{TASK_DIR\}\}\/)(?:SELF-REVIEW|REVIEW)\.md(?![\w./-])/g,
      (_match, prefix: string) => `${prefix}${paths.checklist}`,
    );
}

/** Matching completed lanes keep their distinct feedback files for the fix worker. */
export function reviewFeedbackPathsForFix(run: Run, taskDir: string): string[] {
  const contexts = (run.agentContexts ?? []).filter(
    (context) =>
      context.role === 'review' &&
      context.status === 'complete' &&
      context.taskFile &&
      path.posix.dirname(context.taskFile) === taskDir,
  );
  const paths = [...new Set(contexts.map((context) => reviewerFeedbackRelPath(context.id)))];
  return paths.length ? paths : ['artifacts/review-feedback.md'];
}

export function reviewFeedbackFileList(taskDir: string, paths: readonly string[]): string {
  return paths.map((file) => `- \`${taskDir}/${file}\``).join('\n');
}
