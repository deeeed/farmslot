// Match observed native content, not an ancestor View omitted from Android AX.
const visible = (screen) => screen.nodes.filter((node) => node.visibleToUser !== false);
const text = (node) => node.label || node.value || '';

export function viewSharingRectFits(viewport, rect) {
  return (
    [viewport, rect].every(
      (value) =>
        value &&
        [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
        value.width > 0 &&
        value.height > 0,
    ) &&
    rect.x >= viewport.x &&
    rect.y >= viewport.y &&
    rect.x + rect.width <= viewport.x + viewport.width &&
    rect.y + rect.height <= viewport.y + viewport.height
  );
}

export function viewSharingProfileReady(screen, { gatewayUrl, webBase }) {
  const nodes = visible(screen);
  return (
    nodes.some((node) => node.identifier === 'companion-screen-settings') &&
    nodes.some((node) => text(node) === 'ACTIVE · CONNECTED') &&
    nodes.some((node) =>
      /^Active & connected: Configured Gateway · .* · Healthy$/.test(text(node)),
    ) &&
    nodes.some((node) => text(node) === gatewayUrl) &&
    nodes.some(
      (node) =>
        node.identifier === 'companion-command-center-url-configured-gateway' &&
        (node.value || node.label) === webBase,
    )
  );
}

export function viewSharingArtifactReady(screen, artifactPath) {
  const nodes = visible(screen);
  return (
    !nodes.some((node) => node.identifier === 'companion-artifact-media-viewer') &&
    nodes.some((node) => text(node) === 'Focus: ' + artifactPath) &&
    nodes.some((node) => text(node) === artifactPath) &&
    nodes.some(
      (node) => text(node) === 'Preview' && node.enabled === true && node.hittable === true,
    )
  );
}

export function viewSharingScreenReady(screen, kind, slotId) {
  const nodes = visible(screen);
  if (nodes.some((node) => node.identifier === 'companion-screen-review')) return false;
  if (kind === 'slot') {
    return (
      nodes.some((node) => node.identifier === 'companion-slot-tab-slot') &&
      nodes.some((node) => node.identifier === 'companion-workspace-shortcut-run') &&
      nodes.some((node) => text(node) === slotId)
    );
  }
  if (kind === 'terminal' || kind === 'run-terminal') {
    return (
      nodes.some((node) => /^Tail \d+$/.test(text(node))) &&
      nodes.some((node) => text(node) === (kind === 'terminal' ? slotId : 'Run terminal'))
    );
  }
  return false;
}
