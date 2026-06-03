// chat/assistant-response.ts — Parse model-emitted action and next-step blocks.

import type { ChatNextStep, ChatSuggestedAction } from '@farmslot/protocol';

const ACTIONS_RE = /<actions>([\s\S]*?)<\/actions>/g;
const NEXT_STEPS_RE = /<next_steps>([\s\S]*?)<\/next_steps>/g;
const MAX_NEXT_STEPS = 3;

function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function extractTaggedJsonBlocks(text: string, re: RegExp): { cleanText: string; raws: string[] } {
  const raws: string[] = [];
  const cleanText = text
    .replace(re, (_match, raw: string) => {
      raws.push(stripCodeFence(raw));
      return '';
    })
    .trim();
  return {
    cleanText,
    raws,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseActions(text: string): { cleanText: string; actions: ChatSuggestedAction[] } {
  const { cleanText, raws } = extractTaggedJsonBlocks(text, ACTIONS_RE);
  if (raws.length === 0) return { cleanText, actions: [] };
  let actions: ChatSuggestedAction[] = [];
  for (const raw of raws) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) actions = [...actions, ...parsed];
    } catch (err) {
      console.warn(`[chat] failed to parse actions JSON: ${(err as Error).message}`);
    }
  }
  return { cleanText, actions };
}

function validateNextStep(value: unknown): ChatNextStep | null {
  if (!isObject(value)) return null;
  const { id, label, kind, safety, params } = value;
  if (typeof id !== 'string' || !id.trim()) return null;
  if (typeof label !== 'string' || !label.trim()) return null;
  if (kind !== 'prompt' && kind !== 'read') return null;
  if (safety !== 'read-only') return null;
  if (params !== undefined && !isObject(params)) return null;
  return {
    id,
    label,
    kind,
    safety,
    params: params ?? {},
  };
}

export function parseNextSteps(text: string): { cleanText: string; nextSteps: ChatNextStep[] } {
  const { cleanText, raws } = extractTaggedJsonBlocks(text, NEXT_STEPS_RE);
  if (raws.length === 0) return { cleanText, nextSteps: [] };
  let nextSteps: ChatNextStep[] = [];
  for (const raw of raws) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        nextSteps = [
          ...nextSteps,
          ...parsed.map(validateNextStep).filter((step): step is ChatNextStep => step !== null),
        ];
      }
    } catch (err) {
      console.warn(`[chat] failed to parse next_steps JSON: ${(err as Error).message}`);
    }
  }
  // Co-Pilot UI intentionally presents at most three next-step buttons.
  return { cleanText, nextSteps: nextSteps.slice(0, MAX_NEXT_STEPS) };
}

export function parseAssistantResponse(text: string): {
  cleanText: string;
  actions: ChatSuggestedAction[];
  nextSteps: ChatNextStep[];
} {
  const actionParsed = parseActions(text);
  const nextStepParsed = parseNextSteps(actionParsed.cleanText);
  // Strip unclosed-tag residue first (an LLM that truncated mid-block leaves
  // an opener with no closer; the paired regex skipped it, so the orphan
  // body would otherwise bleed into cleanText). Then sweep any orphan tags.
  const orphanBodyStripped = nextStepParsed.cleanText.replace(
    /<(?:actions|next_steps)>[\s\S]*$/i,
    '',
  );
  return {
    cleanText: orphanBodyStripped.replace(/<\/?(?:actions|next_steps)>/gi, '').trim(),
    actions: actionParsed.actions,
    nextSteps: nextStepParsed.nextSteps,
  };
}
