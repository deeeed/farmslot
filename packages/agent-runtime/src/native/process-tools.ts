import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  isRecord,
  type NativeSessionTool,
  type ProcessEventRef,
  type ProcessMarkCall,
  type ProcessProductEdit,
} from '@farmslot/protocol';
import { nativeToolDiffText, parseUnifiedDiff } from '@farmslot/protocol/client-cache';

export interface ProcessToolObservation {
  id: string;
  at: string;
  phase: 'request' | 'result';
  tool?: NativeSessionTool;
  status?: ProcessMarkCall['status'];
  ref: ProcessEventRef;
}

export interface ProcessToolScope {
  repo: string;
  taskDir: string;
  productPaths: string[];
  markerSignatures: string[];
}

export interface ProjectedProcessTools {
  edits: ProcessProductEdit[];
  marks: ProcessMarkCall[];
  uncertainWrites: boolean;
  uncertainMarks: boolean;
}

/** Match only the additions of an already verified marker; no new marker-admission policy. */
export function markerChangeSignature(
  patch: string,
  operation: '+' | '-' = '+',
): string | undefined {
  const files = parseUnifiedDiff(patch);
  if (
    !files.length ||
    files.some(
      (file) =>
        file.malformed ||
        file.binary ||
        !file.newPath ||
        file.hunks.some((hunk) =>
          hunk.lines.some((line) => line.op !== ' ' && line.op !== operation),
        ),
    )
  )
    return;
  const byPath = new Map<string, string[]>();
  for (const file of files) {
    const lines = byPath.get(file.newPath!) ?? [];
    lines.push(
      ...file.hunks.flatMap((hunk) =>
        hunk.lines.filter((line) => line.op === operation).map((line) => line.text),
      ),
    );
    byPath.set(file.newPath!, lines);
  }
  const rows = [...byPath]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, lines]) => ({ path: file, additions: lines }));
  if (!rows.some((row) => row.additions.length)) return;
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function relativeFile(repo: string, file: string): string | undefined {
  const relative = path.relative(repo, path.resolve(repo, file));
  return relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : undefined;
}

function editClassification(
  tool: NativeSessionTool,
  scope: ProcessToolScope,
  file: string,
): ProcessProductEdit['classification'] {
  const input = isRecord(tool.input) ? tool.input : {};
  const relative = relativeFile(scope.repo, file);
  if (!relative) return 'unknown';
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const diffs =
    tool.diffs?.filter((diff) => relativeFile(scope.repo, diff.path) === relative) ??
    edits.filter(isRecord).flatMap((edit) => {
      const oldText = edit.oldText ?? edit.old_string;
      const newText = edit.newText ?? edit.new_string;
      return typeof oldText === 'string' && typeof newText === 'string'
        ? [{ path: relative, oldText, newText }]
        : [];
    });
  if (!diffs.length) return 'unknown';
  const patch = diffs.map((diff) => nativeToolDiffText({ ...diff, path: relative })).join('\n');
  const added = markerChangeSignature(patch);
  const removed = markerChangeSignature(patch, '-');
  if (
    (added && scope.markerSignatures.includes(added)) ||
    (removed && scope.markerSignatures.includes(removed))
  )
    return 'diagnostic-marker';
  // Pure additions/removals without a verified marker match may still be diagnostic setup.
  if (added || removed || diffs.every((diff) => diff.oldText === diff.newText)) return 'unknown';
  return 'product';
}

interface ShellSegment {
  words: string[];
  complex: boolean;
}

/** Observational subset only: unsupported expansion/nesting never proves a mark's result. */
function shellSegments(command: string): ShellSegment[] {
  // A heredoc body is data, even when it contains a line that looks like a mark.
  if (command.includes('<<')) return [];
  const segments: ShellSegment[] = [];
  const variables = new Map<string, string>();
  let words: string[] = [],
    word = '',
    quote = '',
    complex = false;
  const finishWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const finish = () => {
    finishWord();
    const assignment = words.length === 1 && /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(words[0]);
    if (assignment && !complex) variables.set(assignment[1], assignment[2]);
    if (words.length) segments.push({ words, complex });
    words = [];
    complex = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '$' && quote !== "'") {
      const variable = /^\$(?:\{([A-Za-z_][A-Za-z_0-9]*)\}|([A-Za-z_][A-Za-z_0-9]*))/.exec(
        command.slice(i),
      );
      const value = variable && variables.get(variable[1] ?? variable[2]);
      if (variable && value !== undefined) {
        word += value;
        i += variable[0].length - 1;
        continue;
      }
    }
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') word += command[++i] ?? '';
      else {
        if (quote === '"' && (c === '$' || c === '`')) complex = true;
        word += c;
      }
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '\\') word += command[++i] ?? '';
    else if (';&|\n'.includes(c)) {
      finish();
      if (command[i + 1] === c) i++;
    } else if (/\s/.test(c)) finishWord();
    else {
      if ('$`()<>'.includes(c)) complex = true;
      word += c;
    }
  }
  if (quote) complex = true;
  finish();
  return segments;
}

function markTarget(args: string[]): ProcessMarkCall['target'] {
  const action = args.find(
    (arg) => /^\d+$/.test(arg) || ['start', 'complete', 'block', 'fail', 'sub'].includes(arg),
  );
  if (action && /^\d+$/.test(action) && Number(action) > 0)
    return { action: 'step', stepNumber: Number(action) };
  if (action === 'sub') return { action: 'subtask' };
  if (action === 'start' || action === 'complete' || action === 'block' || action === 'fail')
    return { action };
  return { action: 'unknown' };
}

export function projectProcessTools(
  events: ProcessToolObservation[],
  scope: ProcessToolScope,
): ProjectedProcessTools {
  const requests = new Map<string, ProcessToolObservation>();
  const results = new Map<string, ProcessToolObservation>();
  for (const event of events) {
    if (event.phase === 'result') results.set(event.id, event);
    else if (!requests.has(event.id) && Number.isFinite(Date.parse(event.at)))
      requests.set(event.id, event);
  }
  const edits: ProcessProductEdit[] = [],
    marks: ProcessMarkCall[] = [];
  let uncertainWrites = false;
  let uncertainMarks = false;
  const paths = new Set(scope.productPaths);
  const taskMark = path.join(scope.taskDir, 'mark');
  for (const [id, event] of requests) {
    const tool = event.tool;
    if (!tool) {
      uncertainWrites = true;
      uncertainMarks = true;
      continue;
    }
    const result = results.get(id);
    if (tool.kind === 'file-edit') {
      if (!tool.paths?.length || result?.status !== 'succeeded') uncertainWrites = true;
      for (const file of tool.paths ?? []) {
        const relative = relativeFile(scope.repo, file);
        if (!relative || !paths.has(relative)) continue;
        const classification = editClassification(tool, scope, file);
        if (classification === 'unknown') uncertainWrites = true;
        edits.push({
          at: event.at,
          path: relative,
          status:
            result?.status === 'succeeded'
              ? 'observed'
              : result?.status === 'failed'
                ? 'failed'
                : result
                  ? 'unknown'
                  : 'requested',
          classification,
          source: event.ref,
          ...(result ? { resultSource: result.ref } : {}),
          ...(result && Number.isFinite(Date.parse(result.at)) ? { completedAt: result.at } : {}),
        });
      }
    } else if (tool.kind === 'command' && tool.command) {
      const segments = shellSegments(tool.command);
      if (!segments.length) {
        uncertainWrites = true;
        uncertainMarks = true;
      }
      let cwd = scope.repo;
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const [executable, ...args] = segment.words;
        if (executable === 'cd' && args.length === 1 && !segment.complex) {
          cwd = path.resolve(cwd, args[0]);
          continue;
        }
        const cliMark =
          executable &&
          path.basename(executable) === 'farmslot-agent' &&
          args[0] === 'mark' &&
          args[1] &&
          path.resolve(cwd, args[1]) === scope.taskDir;
        const markArgs =
          executable && path.resolve(cwd, executable) === taskMark
            ? args
            : cliMark
              ? args.slice(2)
              : undefined;
        if (!segment.complex && markArgs) {
          const option = markArgs.indexOf('--checklist');
          const selected = option >= 0 ? markArgs[option + 1] : 'CHECKLIST.md';
          const checklist = selected && relativeFile(scope.taskDir, selected);
          marks.push({
            at: event.at,
            toolId: id,
            commandIndex: index,
            checklist: checklist ?? null,
            target: markTarget(markArgs),
            status: segments.length === 1 && result ? (result.status ?? 'unknown') : 'unknown',
            source: event.ref,
            ...(result ? { resultSource: result.ref } : {}),
          });
        } else {
          uncertainWrites = true;
          uncertainMarks = true;
        }
      }
    } else if (tool.kind === 'other' || !tool.kind || tool.kind === 'command') {
      uncertainWrites = true;
      uncertainMarks = true;
    }
  }
  return { edits, marks, uncertainWrites, uncertainMarks };
}
