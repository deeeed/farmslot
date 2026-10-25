/** Missing optional or dispatch-scoped placeholder templates are not stale fixtures. */
export function isOptionalFixtureAbsence(
  template: { src?: string; optional?: boolean },
  expandedSource: string,
): boolean {
  return !!template.optional || /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(expandedSource);
}
