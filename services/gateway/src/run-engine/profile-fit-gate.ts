import type {
  ProfileFitSuggestion,
  Run,
  RunTicketData,
  ValidationPlanStep,
} from '@farmslot/protocol';

const FARMSLOT_PROJECT = 'farmslot';

const COMPANION_TOKENS = [
  'companion',
  'mobile',
  'apps/companion',
  'expo',
  'react native',
  'pairing',
  'testflight',
  'simulator',
  'metro',
];

const GATEWAY_TOKENS = ['gateway', 'protocol', 'rpc', 'run-engine', 'slot.prepare', 'services/gateway'];

const COMMAND_CENTER_TOKENS = [
  'command center',
  'command-center',
  'dispatch wizard',
  'cdp',
  'ui',
  'vite',
  '#runs',
];

const GATEWAY_ONLY_PROFILES = new Set(['sandbox', 'attach', 'typecheck']);
const COMPANION_PROFILES = new Set(['companion-warm', 'companion-full']);
const STACK_PROFILE = 'stack-dogfood';

export type ProfileFitContext = {
  slotPlatform?: string | null;
  prepareProfile?: string | null;
  app?: string | null;
};

function buildHaystack(run: Run, ticketData: RunTicketData | null): string {
  return [
    run.ticketOrPr,
    run.app,
    ticketData?.title,
    ticketData?.description,
    ticketData?.affectedArea,
    ...(ticketData?.acceptanceCriteria ?? []),
    ...(ticketData?.labels ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function haystackMatches(haystack: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => haystack.includes(token));
}

function detectSurfaces(haystack: string): {
  companion: boolean;
  gateway: boolean;
  commandCenter: boolean;
} {
  return {
    companion: haystackMatches(haystack, COMPANION_TOKENS),
    gateway: haystackMatches(haystack, GATEWAY_TOKENS),
    commandCenter: haystackMatches(haystack, COMMAND_CENTER_TOKENS),
  };
}

function defaultPrepareProfile(platform?: string | null): string {
  if (platform === 'ios' || platform === 'android') return 'companion-warm';
  return 'sandbox';
}

function buildValidationPlan(
  surfaces: ReturnType<typeof detectSurfaces>,
  primaryPrepareProfile: string,
  slotPlatform?: string | null,
): ValidationPlanStep[] {
  const steps: ValidationPlanStep[] = [];
  if (surfaces.commandCenter || surfaces.gateway) {
    steps.push({
      surface: 'command-center',
      kind: 'cdp',
      route: '#runs',
    });
    steps.push({
      surface: 'gateway',
      kind: 'rpc',
      method: 'run.list',
    });
  }
  if (surfaces.companion) {
    steps.push({
      surface: 'companion',
      kind: 'recipe',
      recipe: 'mobile-companion.recipe.json',
      prepareProfile: slotPlatform === 'cli' ? 'companion-warm' : primaryPrepareProfile,
      slot: slotPlatform === 'ios' || slotPlatform === 'android' ? 'macwork-fc-1' : undefined,
    });
  }
  return steps;
}

function suggestPrepareProfile(
  surfaces: ReturnType<typeof detectSurfaces>,
  slotPlatform?: string | null,
): { profile: string; confidence: ProfileFitSuggestion['confidence']; rationale: string } | null {
  const needsCompanion = surfaces.companion;
  const needsStack =
    needsCompanion && (surfaces.gateway || surfaces.commandCenter || slotPlatform === 'cli');

  if (needsStack) {
    return {
      profile: STACK_PROFILE,
      confidence: 'high',
      rationale:
        'Ticket metadata references companion plus gateway or Command Center surfaces — use stack-dogfood.',
    };
  }
  if (needsCompanion) {
    return {
      profile: slotPlatform === 'ios' || slotPlatform === 'android' ? 'companion-warm' : STACK_PROFILE,
      confidence: 'high',
      rationale: 'Ticket metadata references companion/mobile work.',
    };
  }
  return null;
}

export function detectProfileFit(
  run: Run,
  ticketData: RunTicketData | null,
  context: ProfileFitContext = {},
): ProfileFitSuggestion | null {
  if (run.project !== FARMSLOT_PROJECT) return null;
  if (context.prepareProfile?.trim() || run.prepareProfile?.trim()) return null;

  const haystack = buildHaystack(run, ticketData);
  const surfaces = detectSurfaces(haystack);
  if (!surfaces.companion && !surfaces.gateway && !surfaces.commandCenter) return null;

  const suggestion = suggestPrepareProfile(surfaces, context.slotPlatform);
  if (!suggestion) return null;

  const currentProfile =
    context.prepareProfile?.trim() || run.prepareProfile?.trim() || defaultPrepareProfile(context.slotPlatform);

  const gatewayOnlyMismatch =
    surfaces.companion && GATEWAY_ONLY_PROFILES.has(currentProfile) && !context.prepareProfile?.trim();
  const companionMismatch =
    (surfaces.gateway || surfaces.commandCenter) &&
    COMPANION_PROFILES.has(currentProfile) &&
    !surfaces.companion;

  if (!gatewayOnlyMismatch && !companionMismatch && currentProfile === suggestion.profile) {
    return null;
  }

  if (gatewayOnlyMismatch || companionMismatch || currentProfile !== suggestion.profile) {
    const suggestedApp = surfaces.companion && !surfaces.gateway ? 'companion' : undefined;
    return {
      suggestedPrepareProfile: suggestion.profile,
      suggestedApp,
      confidence: suggestion.confidence,
      rationale: suggestion.rationale,
      validationPlan: buildValidationPlan(surfaces, suggestion.profile, context.slotPlatform),
    };
  }

  return null;
}

export function effectivePrepareProfile(
  run: Run,
  context: ProfileFitContext = {},
): string {
  return (
    context.prepareProfile?.trim() ||
    run.prepareProfile?.trim() ||
    defaultPrepareProfile(context.slotPlatform)
  );
}