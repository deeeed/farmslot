import {
  assertArtifactOnlyTaskGuard,
  evaluateArtifactOnlyTaskGuard,
} from './artifact-only-guard.js';

export interface ArtifactOnlyReplay {
  base: string;
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
  const harnessOverlayGuardrail = replay.ignoredPaths?.length
    ? `Ignore injected recipe-harness overlay paths when reasoning about the product bug or product diff: ${replay.ignoredPaths.map((entry) => `\`${entry}\``).join(', ')}.`
    : '';
  const artifactOnlyPreamble = [
    '## Artifact-only replay guardrails',
    '',
    `This task is an artifact-only comparison replay from \`${replayBase}\`.`,
    'The local `main` branch may be newer than this replay base and may already contain the original fix; do not use `main` as the comparison baseline.',
    `When inspecting candidate changes, compare against the replay base: \`git diff ${replayBase}\` (or \`git diff ${replayBase} -- <paths>\`).`,
    harnessOverlayGuardrail,
    'Avoid every publication action: no remote pushes, no GitHub PR CLI mutations, no ready/merge/publication state changes.',
    'Leave the local working-tree diff, validation evidence, and artifacts as the output. Stop after writing `artifacts/report.md` and the completion signal.',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  let result = markdown.replace(/^(#.+\n)/, `$1\n${artifactOnlyPreamble}`);

  result = result.replace(
    / {2}- \*\*If PR_NUMBER is empty\*\* — create the branch and draft PR:[\s\S]*? {4}Update `PR_NUMBER:`[^\n]*(?:\n|$)/g,
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
  );

  result = result.replace(
    /or create it from `[^`]+` if needed\./g,
    `or verify it was prepared from replay base \`${replayBase}\`; do not recreate it from \`main\`.`,
  );
  result = result.replace(/git diff main\.\.\.HEAD/g, `git diff ${replayBase}`);
  result = result.replace(/git diff main\.\.HEAD/g, `git diff ${replayBase}`);
  result = result.replace(/git log main\.\.HEAD/g, `git log ${replayBase}..HEAD`);
  result = result.replace(/git log HEAD\.\.main/g, `git log HEAD..${replayBase}`);
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
