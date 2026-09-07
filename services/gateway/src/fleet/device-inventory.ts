/**
 * What devices a machine actually has (MANUAL-000124).
 *
 * ADR-054 item 3 shipped re-targeting with the provider's own acquire action as
 * the only validator, and that action runs AFTER the posture released the
 * device the run was holding. A mistyped identity therefore cost a run its
 * device and gave it nothing back. This module is the read that lets the
 * re-target be refused first, and the list a picker can offer.
 *
 * Everything that parses is pure and exported, so the tool output shapes are
 * testable without a machine. Everything that executes goes through the node
 * exec path, so a remote machine answers for its own devices.
 *
 * ON PARSING TOOL OUTPUT. `xcrun simctl` has a JSON mode and it is used — no
 * text scraping. `adb devices -l` and `emulator -list-avds` have no JSON mode at
 * all, so their line formats are parsed structurally (fixed columns and
 * `key:value` tokens for adb, one name per line for emulator). This is the
 * narrow exception the "never match tool text" rule leaves open for tools with
 * no machine-readable output, and it is confined to this file. Nothing here
 * derives runner, worker, or run state from text; it only enumerates hardware.
 *
 * WHAT EACH TOOL CAN PROVE. `simctl` and `emulator -list-avds` enumerate what
 * EXISTS, so an identity they omit does not exist and a re-target naming it is
 * refused. `adb devices -l` enumerates currently CONNECTED transports, so an
 * unplugged phone and an unbooted emulator are both absent from it — and
 * booting one is exactly what the provider acquire does next. An `adb_serial`
 * this inventory does not list is therefore NEVER refused; the provider's own
 * `adb get-state` stays the closed door. `DEVICE_INVENTORY_KEY_LISTS_EXISTENCE`
 * in the protocol is where that distinction lives, and `deviceInventoryCovers`
 * is the one predicate that reads it.
 */
import {
  deviceInventoryCovers,
  type DeviceInventoryEntry,
  type DeviceInventoryKey,
  type DeviceInventoryRefusal,
  type DeviceInventoryResult,
  type DeviceInventorySource,
  isRuntimeCapabilityTargetValue,
  RUNTIME_CAPABILITY_TARGET_KEYS,
  type RuntimeCapabilityTarget,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';

import { execResourceCommand, type ResourceCommandExec } from './resource-exec.js';
import { loadFleetStatus } from './state.js';

/** How long one machine's inventory is reused. Short: devices come and go. */
export const DEVICE_INVENTORY_TTL_MS = 30_000;

/**
 * Per-tool budget. The three tools run in PARALLEL, so this is the whole read's
 * bound rather than a third of it: sequentially at 15s each, one unresponsive
 * node stalled a posture reconcile — and the `recipe.rerun` preflight behind
 * it — for 45 seconds on a path that previously executed nothing.
 */
const TOOL_TIMEOUT_MS = 10_000;

interface CacheEntry {
  collectedAt: string;
  expiresAt: number;
  devices: DeviceInventoryEntry[];
  sources: DeviceInventorySource[];
}

/**
 * Keyed by machine AND the working directory the tools ran in.
 *
 * The machine is what the tools answer for, but they are executed with a slot's
 * repo as cwd, and two slots on one machine can have different environments —
 * a checkout whose PATH finds `adb` and one whose does not. Sharing on machine
 * alone let the first slot to ask poison the picker for its sibling for the
 * whole TTL.
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(machine: string, cwd: string): string {
  return `${machine}\u0000${cwd}`;
}

/** Drop every cached machine. Used by the tests, and by a pool/config reload. */
export function clearDeviceInventoryCache(): void {
  cache.clear();
}

// ─── Parsers ───

/**
 * `xcrun simctl list devices -j`.
 *
 * Each simulator yields TWO entries: one under `simulator` (its name, which is
 * what pool JSON and `{{simulator}}` carry) and one under `udid`. Both are legal
 * re-target identities for the same device, and an operator picking from the
 * list must be able to send either.
 *
 * Unavailable runtimes are dropped: `isAvailable: false` means the runtime is
 * not installed, so booting it would fail — offering it as a target would
 * reproduce exactly the failure this inventory exists to prevent.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSimctlDevices(stdout: string): DeviceInventoryEntry[] {
  const parsed: unknown = JSON.parse(stdout);
  const byRuntime = isRecord(parsed) ? parsed.devices : undefined;
  if (!isRecord(byRuntime)) return [];
  const entries: DeviceInventoryEntry[] = [];
  for (const devices of Object.values(byRuntime)) {
    if (!Array.isArray(devices)) continue;
    for (const record of devices) {
      if (!isRecord(record)) continue;
      if (record.isAvailable === false) continue;
      const udid = typeof record.udid === 'string' ? record.udid : '';
      const name = typeof record.name === 'string' ? record.name : '';
      const state = typeof record.state === 'string' ? record.state : 'unknown';
      if (!udid || !name) continue;
      if (isRuntimeCapabilityTargetValue(name)) {
        entries.push({ platform: 'ios', key: 'simulator', identity: name, name, state });
      }
      if (isRuntimeCapabilityTargetValue(udid)) {
        entries.push({ platform: 'ios', key: 'udid', identity: udid, name, state });
      }
    }
  }
  return entries;
}

/**
 * `adb devices -l`.
 *
 * Line shape, fixed by adb: `<serial> <state> [key:value ...]`, after a
 * `List of devices attached` header. The trailing tokens are adb's own
 * `key:value` pairs, so `model:` is read as a token rather than matched out of
 * a sentence.
 */
/**
 * The states `adb devices` prints in its second column.
 *
 * A row is only a device row when its second token is one of these. adb also
 * writes ordinary prose to stdout — `adb server version (41) doesn't match this
 * client` parsed as serial `adb`, state `server`, and that phantom showed up in
 * the operator's picker. Requiring a known state token is the structural test
 * for "this line is a device row", not a match against the prose.
 */
const ADB_DEVICE_STATES = new Set([
  'device',
  'offline',
  'unauthorized',
  'authorizing',
  'connecting',
  'bootloader',
  'recovery',
  'sideload',
  'rescue',
  'host',
  'no',
  'unknown',
]);

export function parseAdbDevices(stdout: string): DeviceInventoryEntry[] {
  const entries: DeviceInventoryEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue; // adb's own daemon chatter
    // adb's own diagnostics ("error: no devices/emulators found") share stdout
    // with device rows; a serial never carries a colon-terminated word.
    if (line.startsWith('error:') || line.startsWith('adb:')) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state || serial.endsWith(':')) continue;
    if (!ADB_DEVICE_STATES.has(state)) continue;
    if (!isRuntimeCapabilityTargetValue(serial)) continue;
    const tokens = new Map<string, string>();
    for (const token of rest) {
      const separator = token.indexOf(':');
      if (separator <= 0) continue;
      tokens.set(token.slice(0, separator), token.slice(separator + 1));
    }
    entries.push({
      platform: 'android',
      key: 'adb_serial',
      identity: serial,
      name: tokens.get('model') ?? tokens.get('device') ?? serial,
      state,
    });
  }
  return entries;
}

/**
 * `emulator -list-avds` — one avd name per line.
 *
 * The state is `available`, not `running`: this tool lists what CAN be booted
 * and says nothing about what is. Claiming otherwise would be inventing a fact
 * the tool did not report.
 */
export function parseEmulatorAvds(stdout: string): DeviceInventoryEntry[] {
  const entries: DeviceInventoryEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const name = rawLine.trim();
    if (!name) continue;
    // The emulator prints load warnings on stdout on some installs. An avd name
    // never contains whitespace, so a line that does is not one.
    if (/\s/.test(name)) continue;
    if (!isRuntimeCapabilityTargetValue(name)) continue;
    entries.push({ platform: 'android', key: 'avd', identity: name, name, state: 'available' });
  }
  return entries;
}

// ─── Nearest identities ───

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous[j]!;
      previous[j] = next;
    }
  }
  return previous[b.length]!;
}

/**
 * The identities of one key closest to what was asked for, nearest first.
 *
 * Case-insensitive edit distance, then alphabetical so the list is stable
 * between reads. Capped: a refusal an operator has to scroll is not a help.
 */
export function nearestIdentities(
  devices: readonly DeviceInventoryEntry[],
  key: DeviceInventoryKey,
  identity: string,
  limit = 5,
): string[] {
  const wanted = identity.toLowerCase();
  return [...new Set(devices.filter((d) => d.key === key).map((d) => d.identity))]
    .sort((a, b) => {
      const delta = editDistance(a.toLowerCase(), wanted) - editDistance(b.toLowerCase(), wanted);
      return delta !== 0 ? delta : a.localeCompare(b);
    })
    .slice(0, limit);
}

// ─── The rule ───

/**
 * Whether a re-target names a device this inventory says does not exist.
 *
 * FAILS OPEN, deliberately, and this is the whole design of the check: the
 * inventory is an optimisation over the provider's own boot, which already
 * fails closed. Silence is evidence only when `deviceInventoryCovers` says it
 * is — the tool that answers for the key ran, AND that tool enumerates what
 * exists rather than what is currently connected. A tool that did not run (no
 * Xcode, no adb on the PATH, a node that did not reply) and every `adb_serial`,
 * whose tool lists only live transports, fall through to the provider exactly
 * as they did before this existed.
 *
 * Returns null when there is nothing to refuse.
 */
export function deviceInventoryRefusal(
  target: RuntimeCapabilityTarget | Record<string, unknown>,
  inventory: Pick<DeviceInventoryResult, 'machine' | 'devices' | 'sources'>,
): DeviceInventoryRefusal | null {
  for (const key of RUNTIME_CAPABILITY_TARGET_KEYS) {
    if (key === 'platform') continue;
    const identity = (target as Record<string, unknown>)[key];
    if (!isRuntimeCapabilityTargetValue(identity)) continue;
    if (!deviceInventoryCovers(inventory.sources, key)) continue;
    const known = inventory.devices.some(
      (device) => device.key === key && device.identity === identity,
    );
    if (known) continue;
    const nearest = nearestIdentities(inventory.devices, key, identity);
    return {
      code: 'device-not-in-inventory',
      machine: inventory.machine,
      key,
      identity,
      nearest,
      reason:
        `machine '${inventory.machine}' has no ${key} '${identity}'` +
        (nearest.length > 0 ? `; it does have ${nearest.join(', ')}` : '; it lists none'),
    };
  }
  return null;
}

// ─── Collection ───

interface ToolRun {
  tool: DeviceInventorySource['tool'];
  cmd: string;
  parse: (stdout: string) => DeviceInventoryEntry[];
}

const TOOL_RUNS: ToolRun[] = [
  { tool: 'simctl', cmd: 'xcrun simctl list devices -j', parse: parseSimctlDevices },
  { tool: 'adb', cmd: 'adb devices -l', parse: parseAdbDevices },
  { tool: 'emulator', cmd: 'emulator -list-avds', parse: parseEmulatorAvds },
];

/**
 * The slot on `machine` whose configured resources name each identity.
 *
 * Read from the same `loadSlotVars` the re-target guard reads, so the two can
 * never disagree about which slot owns a device. A slot whose config cannot be
 * read is skipped rather than failing the whole inventory: this field is a
 * label, and losing it costs an operator a hint, not correctness.
 */
export function groupConfiguredIdentities(
  slots: ReadonlyArray<{ slot: string; resourceVars: Record<string, string> }>,
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { slot, resourceVars } of slots) {
    for (const key of RUNTIME_CAPABILITY_TARGET_KEYS) {
      if (key === 'platform') continue;
      const value = resourceVars[key];
      if (!isRuntimeCapabilityTargetValue(value)) continue;
      // Every slot, not the first: one physical device configured on two slots
      // is the contention case, and reporting one of them would hide the other.
      const owning = owners.get(`${key}:${value}`) ?? [];
      if (!owning.includes(slot)) owning.push(slot);
      owners.set(`${key}:${value}`, owning);
    }
  }
  return owners;
}

/**
 * The reads this module makes, injectable so the cache, the TTL, the `refresh`
 * bypass and the configured-slot labelling are all testable without a machine.
 */
export interface DeviceInventoryDeps {
  exec: ResourceCommandExec;
  loadSlotVars: (
    slotId: string,
  ) => Promise<{ machine: string; repo: string; resourceVars: Record<string, string> }>;
  loadFleetStatus: () => Promise<{ slots: Array<{ slot: string; machine: string }> }>;
  now: () => number;
}

const productionDeps: DeviceInventoryDeps = {
  exec: execResourceCommand,
  loadSlotVars,
  loadFleetStatus,
  now: Date.now,
};

async function configuredSlots(
  machine: string,
  deps: DeviceInventoryDeps,
): Promise<Map<string, string[]>> {
  const resolved: Array<{ slot: string; resourceVars: Record<string, string> }> = [];
  const fleet = await deps.loadFleetStatus();
  for (const slot of fleet.slots) {
    if (slot.machine !== machine) continue;
    let vars;
    try {
      vars = await deps.loadSlotVars(slot.slot);
    } catch (error) {
      console.warn(
        `[device-inventory] skipping ${slot.slot} while labelling configured devices: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    resolved.push({ slot: slot.slot, resourceVars: vars.resourceVars });
  }
  return groupConfiguredIdentities(resolved);
}

/**
 * Read the devices available to a slot's machine.
 *
 * Cached per MACHINE, not per slot: the tools answer for the host, and two
 * slots on one machine asking within the window must not run `simctl` twice.
 */
export async function readDeviceInventory(
  slotId: string,
  opts?: { refresh?: boolean; deps?: Partial<DeviceInventoryDeps> },
): Promise<DeviceInventoryResult> {
  const deps: DeviceInventoryDeps = { ...productionDeps, ...opts?.deps };
  const slotVars = await deps.loadSlotVars(slotId);
  const machine = slotVars.machine;
  const key = cacheKey(machine, slotVars.repo);
  const cached = cache.get(key);
  if (!opts?.refresh && cached && cached.expiresAt > deps.now()) {
    return {
      machine,
      slotId,
      devices: cached.devices,
      sources: cached.sources,
      collectedAt: cached.collectedAt,
      cached: true,
    };
  }

  // In parallel, so the whole read is bounded by one tool's timeout rather than
  // the sum of three. Routed through the resource exec path, so a slot on
  // another machine has its own node answer. A missing tool exits non-zero here
  // rather than throwing, which is exactly the "did not answer" case the rule
  // fails open on.
  const answers = await Promise.all(
    TOOL_RUNS.map(async (run) => {
      const result = await deps.exec(slotId, slotVars.repo, run.cmd, TOOL_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        return {
          source: {
            tool: run.tool,
            ok: false,
            detail: result.stderr?.trim() || `exit ${result.exitCode}`,
          } satisfies DeviceInventorySource,
          devices: [] as DeviceInventoryEntry[],
        };
      }
      try {
        return {
          source: { tool: run.tool, ok: true } satisfies DeviceInventorySource,
          devices: run.parse(result.stdout),
        };
      } catch (error) {
        // Handled, not swallowed: output we cannot parse is output we cannot
        // treat as evidence, so the source is marked unread and the rule above
        // fails open for the keys it covers.
        return {
          source: {
            tool: run.tool,
            ok: false,
            detail: `unparseable ${run.tool} output: ${
              error instanceof Error ? error.message : String(error)
            }`,
          } satisfies DeviceInventorySource,
          devices: [] as DeviceInventoryEntry[],
        };
      }
    }),
  );
  const sources = answers.map((answer) => answer.source);
  const devices = answers.flatMap((answer) => answer.devices);

  const owners = await configuredSlots(machine, deps);
  const labelled = devices.map((device) => {
    const owning = owners.get(`${device.key}:${device.identity}`);
    return owning?.length ? { ...device, configuredForSlots: [...owning].sort() } : device;
  });
  labelled.sort((a, b) => a.key.localeCompare(b.key) || a.identity.localeCompare(b.identity));

  const collectedAt = new Date(deps.now()).toISOString();
  cache.set(key, {
    collectedAt,
    expiresAt: deps.now() + DEVICE_INVENTORY_TTL_MS,
    devices: labelled,
    sources,
  });
  return { machine, slotId, devices: labelled, sources, collectedAt, cached: false };
}

/**
 * The re-target guard: refuse an identity this slot's machine does not have.
 *
 * NEVER refuses on a cached read. The cache exists so a polling picker does not
 * re-run `simctl` every second, but a simulator created — or a device plugged
 * in — inside the TTL would otherwise be called nonexistent by a snapshot taken
 * before it appeared. So a cached answer that WOULD refuse is re-read fresh
 * first, and only the fresh answer can refuse. That costs one tool sweep on the
 * rare path that is about to say no, and nothing at all on the common path.
 *
 * Reading the inventory can itself fail — an unresolvable slot, a node that
 * threw. That is the unreadable case, and it is NOT a refusal: it returns null
 * and the reason is reported to the caller through `onUnreadable` so the
 * fail-open path is recorded rather than silent.
 */
export async function assertTargetInInventory(
  slotId: string,
  target: RuntimeCapabilityTarget | Record<string, unknown>,
  opts?: { onUnreadable?: (reason: string) => void; deps?: Partial<DeviceInventoryDeps> },
): Promise<DeviceInventoryRefusal | null> {
  const read = async (refresh: boolean): Promise<DeviceInventoryResult | null> => {
    try {
      return await readDeviceInventory(slotId, {
        refresh,
        ...(opts?.deps ? { deps: opts.deps } : {}),
      });
    } catch (error) {
      opts?.onUnreadable?.(
        `device inventory for slot '${slotId}' is unreadable, so the target was not checked against it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  };

  let inventory = await read(false);
  if (!inventory) return null;
  let refusal = deviceInventoryRefusal(target, inventory);
  if (refusal && inventory.cached) {
    const fresh = await read(true);
    if (!fresh) return null;
    inventory = fresh;
    refusal = deviceInventoryRefusal(target, fresh);
  }

  const unreadable = inventory.sources.filter((source) => !source.ok);
  if (unreadable.length > 0) {
    opts?.onUnreadable?.(
      `device inventory on '${inventory.machine}' is partial: ${unreadable
        .map((source) => `${source.tool} (${source.detail ?? 'no detail'})`)
        .join('; ')}`,
    );
  }
  return refusal;
}

// ─── Post-control device state ───

/**
 * The state `simctl` reports for one simulator, matched by name OR udid.
 *
 * Returns null when the tool did not answer or does not know the device — the
 * caller must then keep the failure it already had rather than invent a verdict.
 */
export async function readSimulatorState(
  slotId: string,
  cwd: string,
  identity: string,
  exec: ResourceCommandExec = execResourceCommand,
): Promise<string | null> {
  const result = await exec(slotId, cwd, 'xcrun simctl list devices -j', TOOL_TIMEOUT_MS);
  if (result.exitCode !== 0) return null;
  let devices: DeviceInventoryEntry[];
  try {
    devices = parseSimctlDevices(result.stdout);
  } catch {
    // Handled: output we cannot parse is not evidence of any state, and the
    // caller's fail-closed branch is the correct outcome.
    return null;
  }
  return devices.find((device) => device.identity === identity)?.state ?? null;
}

/**
 * The states each tool reports for a device that has SETTLED, up and down.
 *
 * Everything else is transitional and gets no verdict. `Booting`, `Creating`
 * and `Shutting Down` are not a running device and not a stopped one, and
 * reading `!Booted` as stopped is exactly the mid-transition pass the removed
 * regex used to give. On Android, `offline` and `unauthorized` mean the
 * transport is still attached and the device is still there — not stopped —
 * while a genuinely stopped emulator makes `adb get-state` fail, which is
 * already the no-verdict path.
 */
const SIMCTL_UP = new Set(['Booted']);
const SIMCTL_DOWN = new Set(['Shutdown']);
const ADB_UP = new Set(['device']);
const ADB_DOWN = new Set<string>();

/** True/false when the state settles the question, null while it is in motion. */
function settledVerdict(
  up: ReadonlySet<string>,
  down: ReadonlySet<string>,
  state: string,
  action: 'boot' | 'shutdown',
): boolean | null {
  if (up.has(state)) return action === 'boot';
  if (down.has(state)) return action === 'shutdown';
  return null;
}

/**
 * Whether a boot or shutdown hook that exited non-zero nevertheless left the
 * device in the state the action wanted.
 *
 * This replaces matching `Unable to (shutdown|boot) device in current state` out
 * of the tool's stderr. That text was the ONLY thing standing between a device
 * caught mid-transition and an acquire that believed it had booted, and it is
 * the tool's prose — it changes between Xcode releases and says nothing about
 * the device's actual state. Here the device itself is asked.
 *
 * Returns null when no verdict can be reached — no identity, an unsupported
 * platform, a tool that did not answer. The caller then keeps the failure, which
 * is the fail-closed outcome: a boot whose result we cannot confirm is not a boot.
 */
export async function deviceControlVerdict(input: {
  slotId: string;
  cwd: string;
  platform: string | undefined;
  action: 'boot' | 'shutdown';
  /** Device identity resolved from the lease's parameters, then the slot's. */
  identity: { simulator?: string; udid?: string; adb_serial?: string };
  /** Injectable so the rule is testable without a machine. */
  exec?: ResourceCommandExec;
}): Promise<{ ok: boolean; detail: string } | null> {
  const exec = input.exec ?? execResourceCommand;
  if (input.platform === 'ios') {
    const identity = input.identity.udid ?? input.identity.simulator;
    if (!identity) return null;
    const state = await readSimulatorState(input.slotId, input.cwd, identity, exec);
    if (state === null) return null;
    const verdict = settledVerdict(SIMCTL_UP, SIMCTL_DOWN, state, input.action);
    if (verdict === null) return null;
    return { ok: verdict, detail: `simctl reports ${identity} is ${state}` };
  }
  if (input.platform === 'android') {
    const serial = input.identity.adb_serial;
    if (!serial) return null;
    // The transport list, not `get-state`. `get-state` for a serial that is gone
    // exits non-zero, and an exit code cannot tell "the emulator powered off" —
    // which is a successful shutdown — from "adb is missing" or "the daemon
    // died", which are no verdict at all. A successful `adb devices` answers
    // both questions from one positive signal: the tool ran, and the serial is
    // either in the list or it is not.
    const connected = await readAdbTransports(input.slotId, input.cwd, exec);
    if (connected === null) return null;
    const state = connected.get(serial);
    if (state !== undefined) {
      const verdict = settledVerdict(ADB_UP, ADB_DOWN, state, input.action);
      if (verdict === null) return null;
      return { ok: verdict, detail: `adb reports ${serial} is ${state}` };
    }
    // Absent from a list adb successfully produced. For an EMULATOR that is a
    // settled shutdown: adb names local emulator transports `emulator-<port>`
    // itself, and an emulator that is not a transport is not running. For a
    // physical serial, absence means unplugged, which is not the same as
    // powered off — no verdict.
    if (input.action === 'shutdown' && isEmulatorTransport(serial)) {
      return { ok: true, detail: `adb no longer lists the emulator transport ${serial}` };
    }
    return null;
  }
  return null;
}

/**
 * Whether adb's own transport naming says this serial is a local emulator.
 *
 * `emulator-<port>` is adb's convention for an emulator transport, not a
 * message it prints — the same structural fact `parseAdbDevices` reads the
 * serial column for.
 */
export function isEmulatorTransport(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** Serial to state, from one successful `adb devices -l`, or null if it failed. */
async function readAdbTransports(
  slotId: string,
  cwd: string,
  exec: ResourceCommandExec,
): Promise<Map<string, string> | null> {
  const result = await exec(slotId, cwd, 'adb devices -l', TOOL_TIMEOUT_MS);
  if (result.exitCode !== 0) return null;
  return new Map(parseAdbDevices(result.stdout).map((device) => [device.identity, device.state]));
}
