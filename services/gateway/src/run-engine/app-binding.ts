export interface SlotAppBinding {
  /** The pool slot's `app` (`SlotVars.resourceVars.app`). */
  slotApp: string | undefined;
  /** The project's `recipe.app`. */
  recipeApp: string | undefined;
  /** The project's declared `apps`. */
  apps: readonly string[] | undefined;
}

export interface BoundApp {
  app: string;
  /** `slot`: the pool slot's `app`; `project`: the project's default app. */
  source: 'slot' | 'project';
}

export interface AppBindingMismatch {
  runApp: string;
  slotApp: string;
  source: BoundApp['source'];
}

function normalizeApp(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

/**
 * The app a slot is bound to: its pool `app`, else the project's `recipe.app`,
 * else the project's only declared app. Task initialization binds the recipe
 * the same way, and the slot's runtime hooks never see `run.app`.
 */
export function boundApp(binding: SlotAppBinding): BoundApp | null {
  const slotApp = normalizeApp(binding.slotApp);
  if (slotApp) return { app: slotApp, source: 'slot' };
  const projectApp =
    normalizeApp(binding.recipeApp) ||
    (binding.apps?.length === 1 ? normalizeApp(binding.apps[0]) : '');
  return projectApp ? { app: projectApp, source: 'project' } : null;
}

/** Null when the run names no app, the slot has no binding, or they agree. */
export function appBindingMismatch(
  runApp: string | null | undefined,
  binding: SlotAppBinding,
): AppBindingMismatch | null {
  const requested = normalizeApp(runApp);
  if (!requested) return null;
  const bound = boundApp(binding);
  if (!bound || bound.app === requested) return null;
  return { runApp: requested, slotApp: bound.app, source: bound.source };
}
