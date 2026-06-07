import type { Run, SlotStatus } from '@farmslot/protocol';

import { decisionPayloadKind } from '../shared/decision-payload-model.js';

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface TaskStep {
  text: string;
  checked: boolean;
}

export interface CodeViewerElement extends HTMLElement {
  _editor?: { getValue(): string };
}

export type EditorId = 'cursor' | 'vscode';
export interface EditorOption {
  id: EditorId;
  label: string;
  scheme: string;
}

export const EDITORS: EditorOption[] = [
  { id: 'cursor', label: 'Cursor', scheme: 'cursor' },
  { id: 'vscode', label: 'VS Code', scheme: 'vscode' },
];

export const EDITOR_PREF_KEY = 'farmslot:preferred-editor';
export interface OpenFile {
  path: string;
  type: 'file' | 'diff';
  pinned: boolean;
  diffBase?: string; // branch diff base (for branch-changed-files diffs)
}

export interface GitData {
  branch: string;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; status: string; staged: boolean; oldPath?: string }>;
}

export interface SlotSwitcherEntry {
  slot: string;
  label: string;
  title: string;
}

function slotSwitcherLabel(slot: SlotStatus): string {
  const runRef = slot.currentRunId ? ` · ${slot.currentRunId.slice(0, 8)}` : '';
  const project = slot.project ? ` · ${slot.project}` : '';
  const lifecycle = slot.phase ? `${slot.lifecycle} (${slot.phase})` : slot.lifecycle;
  return `${slot.slot} · ${lifecycle}${project}${runRef}`;
}

export function slotSwitcherEntries(
  slots: readonly SlotStatus[],
  currentSlotId: string,
): SlotSwitcherEntry[] {
  const entries = slots.map((slot) => ({
    slot: slot.slot,
    label: slotSwitcherLabel(slot),
    title: `${slot.machine} · ${slot.platform} · ${slot.branch || 'unknown branch'}`,
  }));
  if (currentSlotId && !entries.some((entry) => entry.slot === currentSlotId)) {
    entries.unshift({
      slot: currentSlotId,
      label: `${currentSlotId} · current`,
      title: 'Current slot is not present in the latest fleet snapshot',
    });
  }
  return entries;
}

export function slotSwitcherSignature(slots: readonly SlotStatus[]): string {
  return slots
    .map((slot) =>
      [
        slot.slot,
        slot.lifecycle,
        slot.phase ?? '',
        slot.project,
        slot.currentRunId ?? '',
        slot.machine,
        slot.platform,
        slot.branch,
      ].join('\u001f'),
    )
    .join('\u001e');
}

export function adjacentSlotId(
  entries: readonly Pick<SlotSwitcherEntry, 'slot'>[],
  currentSlotId: string,
  direction: -1 | 1,
): string {
  if (entries.length === 0) return '';
  const currentIndex = entries.findIndex((entry) => entry.slot === currentSlotId);
  const baseIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
  const nextIndex = (baseIndex + direction + entries.length) % entries.length;
  return entries[nextIndex]?.slot ?? '';
}

export function extToLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    swift: 'swift',
    kt: 'kotlin',
  };
  return map[ext] ?? 'plaintext';
}

export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/** Extract the real file path from a branch diff cache key like "branch:main:path/to/file" */
export function realPath(pathOrKey: string): string {
  if (pathOrKey.startsWith('branch:')) {
    const idx = pathOrKey.indexOf(':', 7); // skip "branch:" then find next ":"
    return idx >= 0 ? pathOrKey.substring(idx + 1) : pathOrKey;
  }
  return pathOrKey;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);
const MEDIA_EXTS = new Set(['.mp4', '.webm']);

export function isImageFile(filePath: string): boolean {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTS.has(ext);
}

export function isMediaFile(filePath: string): boolean {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  return MEDIA_EXTS.has(ext);
}

export function slotViewReadyGateDecision(
  run: Pick<Run, 'decisions'> | null | undefined,
): Run['decisions'][number] | null {
  const readyDecisions =
    run?.decisions.filter((decision) => decisionPayloadKind(decision.payload) === 'ready') ?? [];
  const pending = readyDecisions.find((decision) => !decision.resolvedAt);
  const resolved = readyDecisions
    .filter((decision) => decision.resolvedAt)
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0];
  return pending ?? resolved ?? null;
}

export function slotViewPendingReviewDecision(
  run: Pick<Run, 'decisions'> | null | undefined,
): Run['decisions'][number] | null {
  return (
    run?.decisions.find(
      (decision) => !decision.resolvedAt && decisionPayloadKind(decision.payload) === 'review',
    ) ?? null
  );
}

export function slotViewReviewDrawerKey(input: {
  run: Pick<Run, 'id'> | null | undefined;
  readyDecision: Run['decisions'][number] | null;
  reviewDecision: Run['decisions'][number] | null;
  hasRecipeHost: boolean;
}): string {
  if (input.readyDecision) return `ready:${input.readyDecision.id}`;
  if (input.reviewDecision) return `review:${input.reviewDecision.id}`;
  if (input.hasRecipeHost && input.run) return `recipe:${input.run.id}`;
  return '';
}
