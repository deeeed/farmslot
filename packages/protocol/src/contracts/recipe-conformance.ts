import type { RecipeExecutionPlan } from '../recipe/index.js';

import type { RuntimeCapabilityCatalogEntry } from './runtime-capabilities.js';

export interface RecipeConformanceSource {
  head: string | null;
  status: string;
  sourceFingerprint: string;
  dirtyDigest?: string | null;
}

export interface RecipeConformanceIdentity {
  project: string;
  app: string | null;
  domain: string | null;
  adapter: string;
  target: string;
  trustDigest?: string;
  selection?: {
    slot: string | null;
    poolSlot?: string | null;
    adapterTarget?: string | null;
    device: string | null;
    ports: Record<string, number | string>;
    provider: string | null;
    manifest: string | null;
  };
  checkout: RecipeConformanceSource;
  provider: RecipeConformanceSource;
  implementation?: Array<RecipeConformanceSource & { name: string }>;
  libraries: Array<RecipeConformanceSource & { name: string; path?: string }>;
  invocations?: Array<{ recipe: string; paramsDigest: string }>;
  configuration: Array<{ path: string; sourceFingerprint: string }>;
}

export interface RecipeConformanceLiveEvidence {
  smokeTarget: string;
  teardownTarget: string;
  captureRequired?: boolean;
  hudRequired?: boolean;
  /** Captured files validated for the named smoke, within this artifact package. */
  captures?: string[];
  artifactDir: string;
  artifacts: Array<{ path: string; digest: string }>;
}

export interface RecipeConformanceCheck {
  id: string;
  status: 'pass' | 'fail' | 'missing' | 'skipped' | 'unsupported';
  required: boolean;
  message: string;
  userAction?: string;
  evidence?: { plan: RecipeExecutionPlan; live?: RecipeConformanceLiveEvidence };
}

export interface RecipeConformanceReport {
  schemaVersion: 1;
  checkedAt: string;
  identity: RecipeConformanceIdentity;
  status: 'pass' | 'fail';
  mode: 'static' | 'live';
  capabilities: Array<{ name: string; status: 'declared' | 'verified' | 'failed' | 'unknown' }>;
  checks: RecipeConformanceCheck[];
  resolution?: {
    recipes: Array<{ ref: string; source: string; shadows: string[]; invocation?: string }>;
    actions: Array<{ action: string; source: string; shadows?: string[]; invocation?: string }>;
  };
}

export type RecipeConformanceScope = Pick<
  RecipeConformanceIdentity,
  'project' | 'app' | 'domain' | 'adapter' | 'target'
>;

/** Concrete requirements declared by the selected execution template. */
export interface RecipeFlowRequirements {
  recipes: string[];
  params: Record<string, unknown>;
  actions: string[];
  capture: boolean;
  hud: boolean;
  resources: string[];
}

export interface RecipeProjectCompatibility {
  scope: RecipeConformanceScope;
  registered: boolean;
  recipeVerified: boolean;
  requirements: RecipeConformanceReport['capabilities'];
  missingRequirements: string[];
  diagnostics?: string[];
  checked?: {
    revision: string | null;
    dirtyDigest: string | null;
    checkedAt: string;
    scope: RecipeConformanceScope;
  };
}

/** Missing, skipped and unsupported checks never establish conformance. */
export function conformanceChecksPass(
  checks: readonly RecipeConformanceCheck[],
  mode: RecipeConformanceReport['mode'] = 'static',
): boolean {
  const required = checks.filter((check) => check.required);
  const captureRequired = checks.some(
    (check) => check.id === 'capture.support' && check.status === 'pass',
  );
  return (
    required.length > 0 &&
    required.every((check) => {
      if (check.status !== 'pass' || !check.evidence?.plan) return false;
      if (mode === 'static') return true;
      const live = check.evidence.live;
      const captured = Boolean(
        live?.captures?.length &&
        live.captures.every((file) =>
          live.artifacts.some((artifact) => artifact.path === file && artifact.digest.length > 0),
        ),
      );
      return Boolean(
        live?.smokeTarget &&
        live.teardownTarget &&
        live.artifacts.length &&
        (!captureRequired || live.captureRequired === true) &&
        (!(captureRequired || live.captureRequired) || captured),
      );
    })
  );
}

/** Read requirements from the entry the canonical template selector already chose. */
export function recipeFlowRequirements(
  metadata: Readonly<Record<string, unknown>> | null,
): RecipeFlowRequirements {
  const list = (key: string): string[] => {
    const value = metadata?.[key];
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry !== entry.trim())
    ) {
      throw new Error(`Template ${key} must be an array of nonempty names.`);
    }
    return [...new Set(value as string[])];
  };
  const flag = (key: string): boolean => {
    const value = metadata?.[key];
    if (value === undefined) return false;
    if (typeof value !== 'boolean') throw new Error(`Template ${key} must be a boolean.`);
    return value;
  };
  let params: Record<string, unknown> = {};
  if (metadata?.recipe_params !== undefined) {
    if (typeof metadata.recipe_params !== 'string')
      throw new Error('Template recipe_params must be a JSON object in a scalar string.');
    let decoded: unknown;
    try {
      decoded = JSON.parse(metadata.recipe_params);
    } catch {
      throw new Error('Template recipe_params must contain valid JSON.');
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('Template recipe_params must contain one JSON object.');
    params = decoded as Record<string, unknown>;
  }
  const requirements = {
    recipes: list('recipe_checks'),
    params,
    actions: list('recipe_actions'),
    capture: flag('recipe_capture'),
    hud: flag('recipe_hud'),
    resources: list('runtime_capabilities'),
  };
  if (
    (requirements.actions.length ||
      requirements.capture ||
      requirements.hud ||
      metadata?.recipe_params !== undefined) &&
    !requirements.recipes.length
  ) {
    throw new Error(
      'Template recipe_checks must name a smoke for its required actions and parameters.',
    );
  }
  return requirements;
}

function reportScope(identity: RecipeConformanceScope): RecipeConformanceScope {
  return {
    project: identity.project,
    app: identity.app,
    domain: identity.domain,
    adapter: identity.adapter,
    target: identity.target,
  };
}

/** The caller must revalidate report identities and retained artifacts on the slot first. */
export function recipeProjectCompatibility(input: {
  scope: RecipeConformanceScope;
  registered: boolean;
  required: RecipeFlowRequirements;
  report?: RecipeConformanceReport;
  resources: readonly RuntimeCapabilityCatalogEntry[];
}): RecipeProjectCompatibility {
  const { scope, registered, required, report } = input;
  const matches =
    report !== undefined &&
    Object.entries(scope).every(
      ([key, value]) => report.identity[key as keyof typeof scope] === value,
    );
  const passed =
    matches && report.status === 'pass' && conformanceChecksPass(report.checks, report.mode);
  const successful = passed
    ? report.checks.filter((check) => check.status === 'pass' && check.evidence?.plan)
    : [];
  const actions = new Set<string>(
    successful.flatMap((check) => check.evidence!.plan.nodes.map((node) => node.action)),
  );
  const requirements: RecipeProjectCompatibility['requirements'] = [];
  const add = (
    name: string,
    present: boolean,
    absent: 'failed' | 'unknown' = 'unknown',
    available: 'declared' | 'verified' = 'verified',
  ) => {
    requirements.push({ name, status: present ? available : absent });
  };
  const needsRecipes =
    required.recipes.length > 0 || required.actions.length > 0 || required.capture || required.hud;
  if (needsRecipes) add('provider', registered, 'failed', 'declared');
  for (const recipe of required.recipes) {
    add(
      `recipe.${recipe}`,
      successful.some((check) => check.id === `recipe.${recipe}`),
    );
  }
  for (const action of required.actions)
    add(`action.${action}`, actions.has(action), 'unknown', 'declared');
  if (required.capture)
    add(
      'capture',
      actions.has('ui.screenshot') || actions.has('ui.capture_surface'),
      'unknown',
      'declared',
    );
  if (required.hud) add('hud', actions.has('app.hud'), 'unknown', 'declared');
  const recipeRequirementsPass = requirements.every(
    (check) => check.status === 'verified' || check.status === 'declared',
  );
  for (const id of required.resources) {
    const resource = input.resources.find((entry) => entry.id === id);
    add(
      `resource.${id}`,
      resource?.availability.state === 'available',
      resource ? 'failed' : 'unknown',
      'declared',
    );
  }
  return {
    scope,
    registered,
    recipeVerified: registered && passed && report.mode === 'live' && recipeRequirementsPass,
    requirements,
    missingRequirements: requirements
      .filter((check) => check.status === 'failed' || check.status === 'unknown')
      .map((check) => check.name),
    ...(report
      ? {
          checked: {
            revision: report.identity.checkout.head,
            dirtyDigest: report.identity.checkout.dirtyDigest ?? null,
            checkedAt: report.checkedAt,
            scope: reportScope(report.identity),
          },
        }
      : {}),
  };
}
