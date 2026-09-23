export type ValidationPlanSurface = 'command-center' | 'gateway' | 'companion';

export type ValidationPlanKind = 'cdp' | 'rpc' | 'recipe';

export interface ValidationPlanStep {
  surface: ValidationPlanSurface;
  kind: ValidationPlanKind;
  route?: string;
  method?: string;
  recipe?: string;
  prepareProfile?: string;
  slot?: string;
}

export interface ProfileFitSuggestion {
  suggestedPrepareProfile: string;
  suggestedApp?: string;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  /** Resource incompatibility for the slot selected by dispatch preview. */
  slotResourceBlocker?: string;
  validationPlan?: ValidationPlanStep[];
}
