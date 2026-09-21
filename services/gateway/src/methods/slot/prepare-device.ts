import { execArgvOnSlot, execOnSlot, type SlotVars } from '../../core/index.js';

export async function checkPrepareDevice(vars: SlotVars): Promise<string | null> {
  const simulator = vars.resourceVars.simulator;
  const avd = vars.resourceVars.avd;
  if (vars.platform === 'ios' && simulator) {
    // Device inventory does not depend on the slot checkout existing.
    const result = await execArgvOnSlot(vars, ['xcrun', 'simctl', 'list', 'devices', '-j'], {
      cwd: '/',
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Simulator inventory failed on ${vars.machine} (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    const inventory = JSON.parse(result.stdout) as {
      devices?: Record<
        string,
        Array<{ name?: string; udid?: string; isAvailable?: boolean; availabilityError?: string }>
      >;
    };
    if (
      !inventory.devices ||
      typeof inventory.devices !== 'object' ||
      Array.isArray(inventory.devices) ||
      !Object.values(inventory.devices).every(Array.isArray)
    ) {
      throw new Error(
        `Invalid simulator inventory on ${vars.machine}: expected devices grouped by runtime`,
      );
    }
    const matches = Object.values(inventory.devices)
      .flat()
      .filter((device) => device?.name === simulator || device?.udid === simulator);
    if (!matches.length) throw new Error(`Simulator '${simulator}' not found on ${vars.machine}`);
    if (!matches.some((device) => device.isAvailable === true)) {
      throw new Error(
        `Simulator '${simulator}' unavailable on ${vars.machine}: ${matches.map((device) => device.availabilityError || 'runtime unavailable').join('; ')}`,
      );
    }
    return `Simulator ${simulator} found`;
  }
  if (vars.platform === 'android' && avd) {
    const result = await execOnSlot(
      vars,
      '"${ANDROID_HOME:-$HOME/Android/Sdk}/cmdline-tools/latest/bin/avdmanager" list avd -c',
      { cwd: '/', timeout: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `AVD inventory failed on ${vars.machine} (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    if (!result.stdout.split(/\r?\n/).includes(avd))
      throw new Error(`AVD '${avd}' not found on ${vars.machine}`);
    return `AVD ${avd} found`;
  }
  return null;
}
