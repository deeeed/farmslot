// Migration 001 — stamp schema_version on pool files that predate versioning.
// Pool files without schema_version are version 0; this step brings them to 1
// without touching any user-edited field.
export const id = '001-init-schema-version';
export const toVersion = 1;
export const description = 'Introduce schema_version on pool configs (no field changes)';

export function migrate(pool) {
  // schema_version itself is stamped by the migration runner after this step.
  return pool;
}
