import type {
  CopilotFormatInstructionParams,
  CopilotFormatInstructionResult,
} from '@farmslot/protocol';

const FILLER_PATTERN = /\b(um+|uh+|like|you know|kind of|sort of)\b/gi;
const WHITESPACE_PATTERN = /\s+/g;
const SPOKEN_PREFACE_PATTERNS = [
  /^(hey\s+)?farm\s*slot[, ]+/i,
  /^(ok|okay|so)[, ]+/i,
  /^(can|could|would)\s+you\s+/i,
  /^please\s+/i,
  /^let'?s\s+/i,
  /^let\s+us\s+/i,
  /^(tell|ask)\s+([a-z0-9][a-z0-9_-]*-[a-z0-9_-]+)\s+to\s+/i,
  /^(tell|ask)\s+(the\s+)?(worker|runner|agent|slot)\s+to\s+/i,
  /^send\s+(this\s+)?to\s+(slot\s+)?([a-z0-9][a-z0-9_-]*-[a-z0-9_-]+)\s*:?\s*/i,
  /^send\s+(this\s+)?to\s+(the\s+)?(worker|runner|agent|slot)\s*:?\s*/i,
];
const SLOT_TARGET_PATTERNS = [
  /^(?:tell|ask)\s+([a-z0-9][a-z0-9_-]*-[a-z0-9_-]+)\s+to\b/i,
  /\b(?:slot|worker|runner|agent)\s+([a-z0-9][a-z0-9_-]*-[a-z0-9_-]+)\b/i,
  /\b(?:to|for)\s+(?:slot\s+)?([a-z0-9][a-z0-9_-]*-[a-z0-9_-]+)\b/i,
];
const COMMAND_VERB_PATTERN = /^(run|execute)\s+(.+)$/i;
const COMMAND_START_PATTERN =
  /^(yarn|npm|pnpm|bun|git|gh|bash|sh|python|pytest|adb|expo|eas|xcodebuild|gradle|\.\/)/i;
const SPOKEN_TOKEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\btype check\b/gi, 'typecheck'],
  [/\btype script\b/gi, 'TypeScript'],
  [/\bpre commit\b/gi, 'precommit'],
  [/\bcode review\b/gi, 'code-review'],
  [/\bpull request\b/gi, 'PR'],
  [/\bgit hub\b/gi, 'GitHub'],
  [/\bi\s+o\s+s\b/gi, 'iOS'],
  [/\be\s+a\s+s\b/gi, 'EAS'],
  [/\bc\s+i\b/gi, 'CI'],
  [/\bq\s+r\b/gi, 'QR'],
  [/\bh\s+m\s+r\b/gi, 'HMR'],
  [/\bslash\b/gi, '/'],
  [/\bdot\b/gi, '.'],
  [/\bcolon\b/gi, ':'],
  [/\bdash\b/gi, '-'],
  [/\bhyphen\b/gi, '-'],
];
const COMMON_VOICE_INTENTS: Array<[RegExp, string]> = [
  [
    /^(what'?s|what is|check|report|show|give me)?\s*(your|the)?\s*(current\s+)?status(\s+update)?$/i,
    'Please report current status',
  ],
  [/^(pause|stop|hold)(\s+(work|working|now|please))?$/i, 'Please pause and ask for clarification'],
  [
    /^(continue|resume|proceed|go ahead|go on|keep going|carry on)(\s+(work|working|please|with it|here|with (the )?(current )?task|on (the )?(current )?task))*$/i,
    'Please continue with the current task',
  ],
  [
    /^(run|do|perform)\s+(validation|the validation|tests|the tests|checks|the checks)(\s+and\s+(report|share).*)?$/i,
    'Please run validation and share the result',
  ],
  [
    /^(what'?s next|what next|what should (we|i|you) do next|what should be next( then)?|what is the next step|next step)$/i,
    'Please propose the next concrete step',
  ],
  [
    /^(commit|save)(\s+(all|this|the|current))?(\s+(work|changes|change|diff|patch))?(\s+(and\s+be\s+done|please|now))?$/i,
    'Please commit the current changes with an appropriate conventional commit message',
  ],
  [
    /^(validate|test|check)(\s+(this|it|the work))?\s+on\s+i\s*o\s*s(\s+(and\s+(report|share).*)?)?$/i,
    'Please validate this on iOS and report the evidence',
  ],
];

export function copilotFormatInstruction(
  params: CopilotFormatInstructionParams,
): CopilotFormatInstructionResult {
  const transcript = params.transcript.trim();
  if (!transcript) throw new Error('copilot.formatInstruction requires transcript');

  const explicitTarget = extractExplicitTarget(params);
  const targetSlotId = explicitTarget.slotId ?? params.slotId;
  const targetWorker = params.worker;
  const warnings: string[] = [];
  if (!targetSlotId && !targetWorker)
    warnings.push('No target slot or worker was provided; verify the destination before sending.');
  if (!params.runId && !targetWorker)
    warnings.push('No target run was provided; the mobile client must revalidate before sending.');
  if (explicitTarget.slotId && params.slotId && explicitTarget.slotId !== params.slotId) {
    warnings.push(
      `Transcript mentions target slot ${explicitTarget.slotId}; current terminal is ${params.slotId}. Verify the destination before sending.`,
    );
  } else if (explicitTarget.slotId && targetWorker) {
    warnings.push(
      `Transcript mentions target slot ${explicitTarget.slotId}; current terminal is worker ${targetWorker.nodeId}:${targetWorker.target}. Send only if this selected worker is intentional.`,
    );
  }

  const cleaned = normalizeSpokenInstruction(transcript);
  const draftText = cleaned.match(/[.!?]$/) ? cleaned : `${cleaned}.`;

  return {
    originalTranscript: transcript,
    draftText,
    targetSuggestion: {
      ...(targetSlotId ? { slotId: targetSlotId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
      ...(targetWorker ? { worker: targetWorker } : {}),
    },
    warnings,
  };
}

function extractExplicitTarget(params: CopilotFormatInstructionParams): { slotId?: string } {
  const fromHint = normalizeTargetSlotId(params.targetHint);
  if (fromHint) return { slotId: fromHint };

  for (const pattern of SLOT_TARGET_PATTERNS) {
    const match = params.transcript.match(pattern);
    const slotId = normalizeTargetSlotId(match?.[1]);
    if (slotId) return { slotId };
  }
  return {};
}

function normalizeTargetSlotId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return /^[a-z0-9][a-z0-9_-]*-[a-z0-9_-]+$/.test(normalized) ? normalized : undefined;
}

function normalizeSpokenInstruction(transcript: string): string {
  let cleaned = stripLikelyAsrArtifacts(transcript)
    .replace(FILLER_PATTERN, ' ')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
  for (const pattern of SPOKEN_PREFACE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '').trim();
  }
  for (const [pattern, replacement] of SPOKEN_TOKEN_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = cleaned
    .replace(/\s+([.,:;!?])/g, '$1')
    .replace(/(?<=\w)\s*([/:.-])\s*(?=\w)/g, '$1')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
  cleaned = stripLikelyAsrArtifacts(cleaned);
  if (!cleaned) return transcript;
  const commonIntent = normalizeCommonVoiceIntent(cleaned);
  if (commonIntent) return commonIntent;
  return formatLeadingCommand(capitalizeFirst(cleaned));
}

function stripLikelyAsrArtifacts(transcript: string): string {
  return transcript
    .trim()
    .replace(/\s+\.(?=\s|$)/g, '.')
    .replace(/(?<=\w)\.[a-z]{1,3}$/i, '.')
    .replace(/\s+[a-z]{1,2}\s*$/i, (match, offset: number, text: string) =>
      /\b[a-z]\s+[a-z]$/i.test(text.slice(0, offset).trim()) ? match : '',
    )
    .trim();
}

function normalizeCommonVoiceIntent(text: string): string | null {
  const normalizedText = text.replace(/[.!?]+$/, '').trim();
  for (const [pattern, replacement] of COMMON_VOICE_INTENTS) {
    if (pattern.test(normalizedText)) return replacement;
  }
  return null;
}

function formatLeadingCommand(text: string): string {
  const match = text.match(COMMAND_VERB_PATTERN);
  if (!match) return text;

  const verb = match[1].toLowerCase() === 'execute' ? 'Run' : capitalizeFirst(match[1]);
  const rest = match[2].trim();
  const separatorMatch = rest.match(/\s+(and|then)\s+/i);
  const commandText = separatorMatch ? rest.slice(0, separatorMatch.index).trim() : rest;
  const suffix = separatorMatch ? rest.slice(separatorMatch.index ?? 0) : '';
  if (!COMMAND_START_PATTERN.test(commandText)) return `${verb} ${rest}`;
  return `${verb} \`${commandText}\`${suffix}`;
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
