/**
 * Human-facing reference for a backlog or roadmap item (`MANUAL-000055`, a Jira
 * key, a PR ref) shown alongside its title.
 *
 * Every surface used to render the ref only as a FALLBACK for a missing title,
 * so it disappeared exactly when the item was well-formed. That is the id people
 * say out loud and the id every CLI command takes, and it was the one field the
 * UI hid — leaving no way to tell which node, row or roadmap entry a given
 * `MANUAL-000055` refers to.
 */
export function labelWithRef(title: string | undefined, ref: string | undefined): string {
  const cleanTitle = title?.trim();
  const cleanRef = ref?.trim();
  if (!cleanRef) return cleanTitle ?? '';
  if (!cleanTitle || cleanTitle === cleanRef) return cleanRef;
  return `${cleanRef} · ${cleanTitle}`;
}
