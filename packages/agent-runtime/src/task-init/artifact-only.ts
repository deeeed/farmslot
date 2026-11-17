import { literalReplacement } from '@farmslot/protocol/scripts/literal-replacement.mjs';

import {
  assertArtifactOnlyTaskGuard,
  evaluateArtifactOnlyTaskGuard,
} from './artifact-only-guard.js';

export interface ArtifactOnlyReplay {
  /**
   * The commit this replay compares against. Absent when the run recorded no
   * base: the guardrails then say so, because naming an unresolvable
   * placeholder sends the worker hunting through git history for it.
   */
  base?: string;
  ignoredPaths?: readonly string[];
}

function taskBlockValue(markdown: string, key: string): string {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function stripPublicationLines(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      const guard = evaluateArtifactOnlyTaskGuard(line);
      if (guard.allowed) return line;
      const indent = line.match(/^\s*/)?.[0] ?? '';
      return inFence
        ? `${indent}# Artifact-only replay: publication command removed.`
        : `${indent}Artifact-only replay: publication instruction removed.`;
    })
    .join('\n');
}

export function applyArtifactOnlyTaskPolicy(
  markdown: string,
  replay: ArtifactOnlyReplay | undefined,
  // Split layout: the checklist has no Task block, so BRANCH/REPO come from the
  // task document instead of the markdown being rewritten.
  taskBlockSource: string = markdown,
): string {
  if (!replay) return markdown;
  const branch = taskBlockValue(taskBlockSource, 'BRANCH') || '<branch-from-task-block>';
  const repo = taskBlockValue(taskBlockSource, 'REPO') || '<repo-from-task-block>';
  const replayBase = replay.base;
  const hasBase = typeof replayBase === 'string' && replayBase.trim().length > 0;
  const harnessOverlayGuardrail = replay.ignoredPaths?.length
    ? `Ignore injected recipe-harness overlay paths when reasoning about the product bug or product diff: ${replay.ignoredPaths.map((entry) => `\`${entry}\``).join(', ')}.`
    : '';
  const artifactOnlyPreamble = [
    '## Artifact-only replay guardrails',
    '',
    hasBase
      ? `This task is an artifact-only comparison replay from \`${replayBase}\`.`
      : 'This task is an artifact-only comparison replay. No replay base was recorded for it: do not search branches, tags or git history for one.',
    hasBase
      ? 'The local `main` branch may be newer than this replay base and may already contain the original fix; do not use `main` as the comparison baseline.'
      : 'The local `main` branch may already contain the original fix; do not use `main` as the comparison baseline.',
    hasBase
      ? `When inspecting candidate changes, compare against the replay base: \`git diff ${replayBase}\` (or \`git diff ${replayBase} -- <paths>\`).`
      : 'When inspecting candidate changes, read the working tree itself: `git status --short` and `git diff`.',
    harnessOverlayGuardrail,
    'Avoid every publication action: no remote pushes, no GitHub PR CLI mutations, no ready/merge/publication state changes.',
    'Leave the local working-tree diff, validation evidence, and artifacts as the output. Stop after writing `artifacts/report.md` and the completion signal.',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  let result = markdown.replace(
    /^(#.+\n)/,
    (_match, heading: string) => `${heading}\n${artifactOnlyPreamble}`,
  );

  result = result.replace(
    / {2}- \*\*If PR_NUMBER is empty\*\* — create the branch and draft PR:[\s\S]*? {4}Update `PR_NUMBER:`[^\n]*(?:\n|$)/g,
    literalReplacement(
      [
        '  - **If PR_NUMBER is empty** — artifact-only replay mode: do not open a PR and do not publish. Confirm a local work branch exists only:',
        '    ```bash',
        `    cd "${repo.replace(/"/g, '\\"')}"`,
        `    branch="${branch.replace(/"/g, '\\"')}"`,
        '    current=$(git symbolic-ref --short HEAD 2>/dev/null || true)',
        '    if [ "$current" != "$branch" ]; then',
        '      git checkout -B "$branch"',
        '    fi',
        '    git status --short',
        '    ```',
        '    Leave `PR_NUMBER:` empty. This run ends with local artifacts and working-tree diff only.',
        '',
      ].join('\n'),
    ),
  );

  // The template's own instructions compare against `main`, which the
  // guardrails above forbid. With a base they are rewritten to it; without one
  // they are rewritten to the working tree, because leaving them would tell the
  // worker to use the very baseline the preamble just ruled out.
  result = result.replace(
    /or create it from `[^`]+` if needed\./g,
    literalReplacement(
      hasBase
        ? `or verify it was prepared from replay base \`${replayBase}\`; do not recreate it from \`main\`.`
        : 'or verify it was prepared by this run; do not recreate it from `main`.',
    ),
  );
  result = result.replace(
    /git diff main\.\.\.HEAD/g,
    literalReplacement(hasBase ? `git diff ${replayBase}` : 'git diff'),
  );
  result = result.replace(
    /git diff main\.\.HEAD/g,
    literalReplacement(hasBase ? `git diff ${replayBase}` : 'git diff'),
  );
  result = result.replace(
    /git log main\.\.HEAD/g,
    literalReplacement(hasBase ? `git log ${replayBase}..HEAD` : 'git log -n 20 HEAD'),
  );
  result = result.replace(
    /git log HEAD\.\.main/g,
    literalReplacement(hasBase ? `git log HEAD..${replayBase}` : 'git log -n 20 HEAD'),
  );
  result = result.replace(/commit\/push approval/g, 'artifact-only completion approval');
  result = result.replace(
    /- \[ \] \*\*(\d+)\. On approval — commit, push, update PR:\*\*[\s\S]*?(?=\s*Write completion signal:|\n- \[ \] \*\*\d+\.)/g,
    [
      '- [ ] **$1. Artifact-only completion — leave local evidence only:**',
      '  - Do not push to any remote, use GitHub PR CLI mutation commands, edit/comment on PRs, mark ready, merge, or publish this replay.',
      '  - Leave the working-tree diff, `artifacts/report.md`, and validation artifacts as the comparison output.',
      '',
    ].join('\n'),
  );

  result = stripPublicationLines(result);
  assertArtifactOnlyTaskGuard(result);
  return result;
}
