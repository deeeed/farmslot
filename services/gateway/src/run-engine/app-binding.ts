import { projectDefaultApp } from '@farmslot/protocol';

export type ProjectAppDefaults = Parameters<typeof projectDefaultApp>[0];

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
 * The app a slot is bound to: its pool `app`, else the project's default app.
 * Task initialization re-reads the pool on the node and freezes the recipe
 * binding from these, so `run.app` never reaches it. Prepare does set
 * `resourceVars.app` from the run for its own hooks and fixtures, but Metro and
 * launch actions follow the slot's domain overlay.
 */
export function boundApp(
  slotApp: string | undefined,
  project: ProjectAppDefaults,
): BoundApp | null {
  const own = normalizeApp(slotApp);
  if (own) return { app: own, source: 'slot' };
  const fallback = normalizeApp(projectDefaultApp(project));
  return fallback ? { app: fallback, source: 'project' } : null;
}

/** Null when the run names no app, the slot has no binding, or they agree. */
export function appBindingMismatch(
  runApp: string | null | undefined,
  slotApp: string | undefined,
  project: ProjectAppDefaults,
): AppBindingMismatch | null {
  const requested = normalizeApp(runApp);
  if (!requested) return null;
  const bound = boundApp(slotApp, project);
  if (!bound || bound.app === requested) return null;
  return { runApp: requested, slotApp: bound.app, source: bound.source };
}
