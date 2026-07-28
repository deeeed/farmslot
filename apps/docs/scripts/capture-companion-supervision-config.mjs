export function companionCaptureSlot(pool) {
  const slot = (pool?.slots ?? []).find(
    (candidate) => candidate.project === 'farmslot-farm' || /companion/i.test(candidate.id),
  );
  if (!slot) return null;
  const devServer = slot.resources?.['dev-server'];
  return {
    id: slot.id,
    simulator: slot.resources?.['ios-sim']?.simulator,
    gatewayPort: devServer?.port,
    metroPort: devServer?.metro_port,
    hasDevServer: Boolean(devServer),
  };
}

export function resolveCompanionCapturePorts(env, slot) {
  if (slot && !slot.hasDevServer) {
    throw new Error(
      `Companion slot ${slot.id} is missing resources.dev-server; add it to the pool manually with distinct port and metro_port values.`,
    );
  }

  const gatewayPort = configuredPort(
    env.GATEWAY_PORT,
    slot?.gatewayPort,
    'GATEWAY_PORT/resources.dev-server.port',
  );
  const metroPort = configuredPort(
    env.METRO_PORT,
    slot?.metroPort,
    'METRO_PORT/resources.dev-server.metro_port',
  );
  if (metroPort === null) {
    const action = slot
      ? 'run farmslot update to migrate the pool'
      : 'set FARMSLOT_COMPANION_POOL_JSON to a configured pool or load checkout-local runtime ports';
    throw new Error(`Missing resources.dev-server.metro_port; ${action}.`);
  }
  if (gatewayPort === null) {
    throw new Error(
      'Missing resources.dev-server.port; add the dev-server resource to the pool manually or load checkout-local runtime ports.',
    );
  }
  if (gatewayPort === metroPort) {
    throw new Error(
      'Companion capture requires distinct resources.dev-server.port and metro_port values; run farmslot update or repair the pool manually.',
    );
  }
  return {
    gatewayPort: String(gatewayPort),
    metroPort: String(metroPort),
  };
}

function configuredPort(envValue, resourceValue, label) {
  const value = typeof envValue === 'string' && envValue.trim() ? envValue.trim() : resourceValue;
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535, received: ${value}`);
  }
  return port;
}
