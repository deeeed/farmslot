import { COMMAND_CENTER_SURFACES, type CommandCenterSurfaceDefinition } from '@farmslot/protocol';

export { COMMAND_CENTER_SURFACES, type CommandCenterSurfaceDefinition as CommandCenterSurface };

export function buildCommandCenterSurfaceMap(surfaceId?: string): string {
  const surfaceNames = COMMAND_CENTER_SURFACES.map(
    (surface) => `${surface.surfaceId} (${surface.routePattern})`,
  ).join('; ');
  const surface = surfaceId
    ? COMMAND_CENTER_SURFACES.find((item) => item.surfaceId === surfaceId)
    : undefined;
  const lines = ['## Command Center Surface Map', `Known surfaces: ${surfaceNames}`];
  if (!surface) {
    lines.push(`Matched surface: ${surfaceId ?? 'unknown'} (no detailed registry entry selected)`);
    return lines.join('\n');
  }
  lines.push(
    `Matched surface: ${surface.surfaceId} (${surface.routePattern})`,
    `component: ${surface.componentSymbol} in ${surface.componentPath}`,
    `entities: ${surface.primaryEntities.join(', ')}`,
    `query: ${surface.queryParams.length ? surface.queryParams.join(', ') : 'none'}`,
    `affordances: ${surface.affordances.join(', ')}`,
    `preferred read tools: ${surface.preferredTools.join(', ')}`,
    `source anchors: ${surface.sourceAnchors.join('; ')}`,
  );
  return lines.join('\n');
}
