// Child process for ../metamask-tooling-pack.test.ts: evaluate the slots' runtime
// capability catalog with the gateway's own runtimeCapabilityList. Pool and
// project directories come from FARMSLOT_POOL_DIR / FARMSLOT_PROJECTS_DIR, which
// the gateway reads at import, so this runs in its own process. The PTY module
// is mocked as in gateway tests, so no tmux option is touched.
import '../../../../../services/gateway/src/runtime/mock-pty.test-support.ts';

const { runtimeCapabilityList } =
  await import('../../../../../services/gateway/src/methods/runtime-capabilities.ts');
const result = [];
for (const slotId of process.argv.slice(2)) {
  const list = await runtimeCapabilityList({ slotId });
  result.push({
    slotId,
    capabilities: list.capabilities.map((entry) => ({
      id: entry.id,
      availability: entry.availability,
    })),
  });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
