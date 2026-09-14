import assert from 'node:assert/strict';

import { createAgentDeviceClient } from 'agent-device';

const targetId = process.argv[2];
const direction = process.argv[3] ?? 'down';
assert.ok(['up', 'down'].includes(direction));
assert.ok(targetId?.startsWith('companion-native-'));
assert.equal(process.env.IOS_SIMULATOR, '842A0B52-C423-4C61-B6ED-5011E29C021E');
const client = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
const sessions = (await client.sessions.list()).filter(
  (session) =>
    session.device.ios?.udid === process.env.IOS_SIMULATOR && session.name.startsWith('farmslot-'),
);
assert.equal(sessions.length, 1, 'Expected only the running recipe on the private simulator');
const selection = {
  session: sessions[0].name,
  platform: 'ios',
  target: 'mobile',
  udid: process.env.IOS_SIMULATOR,
};
const moves = [];
for (let attempt = 0; attempt < 10; attempt++) {
  const snapshot = await client.capture.snapshot({
    ...selection,
    interactiveOnly: false,
    forceFull: true,
  });
  const target = snapshot.nodes.find((node) => node.identifier === targetId && node.rect);
  const surface = snapshot.nodes
    .filter((node) => node.type === 'ScrollView' && node.rect)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
  assert.ok(surface, 'The native conversation scroll view is absent');
  const top = surface.rect.y + 20;
  const bottom = surface.rect.y + surface.rect.height - 20;
  const center = target ? target.rect.y + target.rect.height / 2 : undefined;
  if (target && center >= top && center <= bottom && target.visibleToUser !== false) {
    console.log(JSON.stringify({ targetId, revealed: true, moves }));
    process.exit(0);
  }
  // Native accessibility can omit controls outside the viewport.
  const delta =
    center === undefined
      ? direction === 'down'
        ? 240
        : -240
      : Math.max(-240, Math.min(240, center - (top + bottom) / 2));
  assert.ok(
    Math.abs(delta) > 1,
    `Native control remains hidden inside the scroll view: ${targetId}`,
  );
  const x = surface.rect.x + 32;
  const y = (top + bottom) / 2 + delta / 2;
  // Move through the native gesture transport; never set a React or native scroll offset.
  await client.interactions.swipe({
    ...selection,
    from: { x, y },
    to: { x, y: y - delta },
    durationMs: 800,
  });
  moves.push({ fromY: y, toY: y - delta });
  await new Promise((resolve) => setTimeout(resolve, 300));
}
throw new Error(
  `Native control did not become visible: ${targetId}; moves=${JSON.stringify(moves)}`,
);
