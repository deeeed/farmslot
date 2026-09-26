import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateRecipeParams, validateRecipeParamsSchema } from '@farmslot/protocol';

const projectPath = fileURLToPath(
  new URL('../../projects/farmslot-farm/project.json', import.meta.url),
);
const project = JSON.parse(readFileSync(projectPath, 'utf8'));
const bootHook = project.resources['ios-sim'].hooks.boot.replaceAll('{{simulator}}', 'fs-2');
const readinessScript = fileURLToPath(
  new URL('../../projects/farmslot-farm/setup/simulator-boot-readiness.sh', import.meta.url),
);
const readinessRecipe = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/examples/recipes/farmslot/simulator-boot-readiness.recipe.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

test('simulator readiness recipe allows boot, health retries, shutdown, and cleanup', () => {
  assert.ok(readinessRecipe.workflow.nodes.boot.timeout_ms >= 1_200_000);
  assert.equal(validateRecipeParamsSchema(readinessRecipe.paramsSchema).status, 'valid');
  for (const slotId of [
    'mini-mm-2',
    "mini-mm-2'; touch /tmp/farmslot-injection; echo '",
    'mini-mm-2\n',
    '',
  ]) {
    const result = validateRecipeParams(
      { slot_id: slotId, gateway_port: 7801 },
      readinessRecipe.paramsSchema,
    );
    assert.equal(result.status, slotId === 'mini-mm-2' ? 'valid' : 'invalid');
  }
});

test('simulator boot waits for readiness and is safe to retry', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ios-boot-'));
  const state = path.join(directory, 'state');
  const trace = path.join(directory, 'trace');
  writeFileSync(
    path.join(directory, 'xcrun'),
    `#!/bin/sh
case "$2" in
  list) if test "$(cat "$BOOT_STATE")" = booted; then printf '    fs-2 (AA11) (Booted)\n'; else printf '    fs-20 (BB22) (Booted)\n'; fi ;;
  boot) printf 'booted' > "$BOOT_STATE"; printf 'boot\n' >> "$TRACE" ;;
  bootstatus) printf 'bootstatus\n' >> "$TRACE"; test "\${FAIL_BOOTSTATUS:-}" != yes ;;
esac
`,
    { mode: 0o755 },
  );

  try {
    for (const alreadyBooted of [false, true]) {
      writeFileSync(state, alreadyBooted ? 'booted' : 'stopped');
      writeFileSync(trace, '');
      const result = spawnSync('sh', ['-c', bootHook], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          BOOT_STATE: state,
          TRACE: trace,
        },
      });
      assert.equal(result.status, 0, result.stderr.toString());
      assert.deepEqual(
        readFileSync(trace, 'utf8').trim().split('\n'),
        alreadyBooted ? ['bootstatus'] : ['boot', 'bootstatus'],
      );
    }

    const failed = spawnSync('sh', ['-c', bootHook], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        FAIL_BOOTSTATUS: 'yes',
      },
    });
    assert.notEqual(failed.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('simulator readiness handles health failure and extra stream fields', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ios-readiness-'));
  const state = path.join(directory, 'state');
  const trace = path.join(directory, 'trace');
  const failedBootHealth = path.join(directory, 'failed-boot-health');
  const failedShutdownHealth = path.join(directory, 'failed-shutdown-health');
  writeFileSync(state, 'stopped');
  writeFileSync(path.join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    path.join(directory, 'node'),
    `#!/bin/sh
case "$3" in
  fleet.status)
    if test "$STALE_FLEET" = yes; then stale=true; else stale=false; fi
    printf '{"fleet":{"stale":%s,"slots":[{"slot":"mini-mm-2","dispatchable":true,"lifecycle":"%s","currentRunId":null,"agent":"idle"}]}}\\n' "$stale" "$SLOT_LIFECYCLE" ;;
  resource.device.inventory)
    current_state=$(cat "$BOOT_STATE")
    if test "$current_state" = booting; then
      if test -f "$BOOT_INVENTORY_SEEN"; then current_state=booted; printf '%s' "$current_state" > "$BOOT_STATE"; else : > "$BOOT_INVENTORY_SEEN"; fi
    fi
    case "$current_state" in stopped) current_state=Shutdown ;; booting) current_state=Booting ;; booted) current_state=Booted ;; esac
    if test "$current_state" = Shutdown && test "$TRANSIENT_SHUTDOWN" = yes && test ! -f "$INVENTORY_TRANSITION_SEEN"; then
      printf 'Shutting Down' > "$INVENTORY_TRANSITION_SEEN"
      current_state='Shutting Down'
    fi
    if test "$current_state" = Shutdown && test "$LAG_INVENTORY" = yes && test ! -f "$INVENTORY_LAG_SEEN"; then
      : > "$INVENTORY_LAG_SEEN"
      current_state=Booted
    fi
    if test "$FORCE_INVENTORY_BOOTING" = yes; then current_state=Booting; fi
    printf '{"devices":[{"platform":"ios","configuredForSlots":["mini-mm-2"],"state":"%s"}]}\\n' "$current_state" ;;
  resource.health)
    if test "$(cat "$BOOT_STATE")" = stopped; then
      if test "$TRANSIENT_HEALTH_FAILURE" = yes && grep -q shutdown "$TRACE" && test ! -f "$FAILED_SHUTDOWN_HEALTH"; then
        : > "$FAILED_SHUTDOWN_HEALTH"
        printf '{"resources":[{"id":"ios-sim","status":"stopped"}]}\\n'
        exit 1
      fi
      printf '{"resources":[{"id":"ios-sim","status":"stopped","stream":{"state":"cached"}}]}\\n'
    else
      if test "$TRANSIENT_HEALTH_FAILURE" = yes && test ! -f "$FAILED_BOOT_HEALTH"; then
        : > "$FAILED_BOOT_HEALTH"
        printf '{"resources":[{"id":"ios-sim","status":"running"}]}\\n'
        exit 1
      fi
      if test "$FAIL_HEALTH_AFTER_BOOT" = yes; then
        printf 'health failed after boot\\n' >&2
        exit 1
      fi
      printf '{"resources":[{"id":"ios-sim","status":"running","stream":{"state":"cached"}}]}\\n'
    fi ;;
  runtime.capability.acquire)
    if test "$FARMSLOT_RPC_TIMEOUT_MS" -lt 420000; then
      printf 'Acquisition timeout is shorter than its dependency and boot budgets\n' >&2
      exit 1
    fi
    if test "$LEASE_HELD" = yes; then
      printf '{"ok":false,"conflict":{"kind":"resource-held"}}\\n'
      exit 0
    fi
    printf 'boot\\n' >> "$TRACE"
    if test "$FAIL_BOOT_DURING_START" = yes; then exit 1; fi
    if test "$FAIL_ACQUIRE_RESPONSE" = yes; then
      printf booted > "$BOOT_STATE"
      exit 1
    fi
    if test "$STOP_AFTER_ACQUIRE" = yes; then printf stopped > "$BOOT_STATE"; else printf booted > "$BOOT_STATE"; fi
    printf '{"ok":true,"lease":{"capabilityId":"ios-simulator"}}\\n' ;;
  runtime.capability.release)
    if test "$FARMSLOT_RPC_TIMEOUT_MS" -lt 60000; then
      printf 'Release timeout is shorter than simulator and Metro shutdown budgets\n' >&2
      exit 1
    fi
    if test "$FAIL_BOOT_DURING_START" = yes || test "$LEASE_HELD" = yes; then
      printf '{"ok":true,"released":[]}\\n'
      exit 0
    fi
    if test "$FAIL_ACQUIRE_RESPONSE" = yes && test "$FARMSLOT_RPC_TIMEOUT_MS" -lt 540000; then
      printf 'Release cannot wait for an in-flight acquisition\n' >&2
      exit 1
    fi
    if test "$LAG_INVENTORY" = yes; then
      if test -f "$RELEASE_SENTINEL"; then printf '{"ok":true,"released":[]}\\n'; exit 0; fi
      : > "$RELEASE_SENTINEL"
    fi
    printf stopped > "$BOOT_STATE"
    printf 'shutdown\\n' >> "$TRACE"
    printf '{"ok":true,"released":[{"capabilityId":"ios-simulator"}]}\\n' ;;
esac
`,
    { mode: 0o755 },
  );

  try {
    for (const failHealthAfterBoot of [true, false]) {
      writeFileSync(state, 'stopped');
      writeFileSync(trace, '');
      const result = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          BOOT_STATE: state,
          TRACE: trace,
          FAIL_HEALTH_AFTER_BOOT: failHealthAfterBoot ? 'yes' : 'no',
          SLOT_LIFECYCLE: 'ready',
        },
      });
      if (failHealthAfterBoot) assert.notEqual(result.status, 0);
      else {
        assert.equal(result.status, 0, result.stderr.toString());
        for (const nodeName of ['boot-succeeded', 'shutdown']) {
          assert.ok(
            result.stdout.toString().includes(readinessRecipe.workflow.nodes[nodeName].contains),
          );
        }
        assert.match(result.stdout.toString(), /running:\{"id":"ios-sim","status":"running"\}/);
        assert.match(result.stdout.toString(), /stopped:\{"id":"ios-sim","status":"stopped"\}/);
      }
      assert.equal(readFileSync(state, 'utf8'), 'stopped');
      assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['boot', 'shutdown']);
    }

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const transient = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        FAIL_HEALTH_AFTER_BOOT: 'no',
        TRANSIENT_HEALTH_FAILURE: 'yes',
        FAILED_BOOT_HEALTH: failedBootHealth,
        FAILED_SHUTDOWN_HEALTH: failedShutdownHealth,
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.equal(transient.status, 0, transient.stderr.toString());
    assert.match(transient.stderr.toString(), /running health probe failed/);
    assert.match(transient.stderr.toString(), /stopped health probe failed/);
    assert.equal(readFileSync(state, 'utf8'), 'stopped');
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['boot', 'shutdown']);

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const inventoryTransitionSeen = path.join(directory, 'inventory-transition-seen');
    const settling = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        TRANSIENT_SHUTDOWN: 'yes',
        INVENTORY_TRANSITION_SEEN: inventoryTransitionSeen,
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.equal(settling.status, 0, settling.stderr.toString());
    assert.equal(readFileSync(inventoryTransitionSeen, 'utf8'), 'Shutting Down');
    assert.equal(readFileSync(state, 'utf8'), 'stopped');

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const earlyStop = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        STOP_AFTER_ACQUIRE: 'yes',
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.notEqual(earlyStop.status, 0);
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['boot', 'shutdown']);

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const inventoryLagSeen = path.join(directory, 'inventory-lag-seen');
    const releaseSentinel = path.join(directory, 'release-sentinel');
    const delayedInventory = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        LAG_INVENTORY: 'yes',
        INVENTORY_LAG_SEEN: inventoryLagSeen,
        RELEASE_SENTINEL: releaseSentinel,
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.equal(delayedInventory.status, 0, delayedInventory.stderr.toString());
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['boot', 'shutdown']);
    assert.equal(readFileSync(state, 'utf8'), 'stopped');

    const inventoryCommand = readinessRecipe.workflow.nodes['verify-inventory'].cmd
      .replaceAll('{{params.slot_id}}', 'mini-mm-2')
      .replaceAll('{{params.gateway_port}}', '7801');
    for (const forceBooting of [false, true]) {
      const inventoryCheck = spawnSync('sh', ['-c', inventoryCommand], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          BOOT_STATE: state,
          FORCE_INVENTORY_BOOTING: forceBooting ? 'yes' : 'no',
        },
      });
      assert.equal(inventoryCheck.status === 0, !forceBooting);
    }

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const bootInventorySeen = path.join(directory, 'boot-inventory-seen');
    const failedDuringBoot = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        BOOT_INVENTORY_SEEN: bootInventorySeen,
        TRACE: trace,
        FAIL_BOOT_DURING_START: 'yes',
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.notEqual(failedDuringBoot.status, 0);
    assert.equal(readFileSync(state, 'utf8'), 'stopped');
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['boot']);

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const lostResponse = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        FAIL_ACQUIRE_RESPONSE: 'yes',
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.notEqual(lostResponse.status, 0);
    assert.equal(readFileSync(state, 'utf8'), 'stopped');
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['boot', 'shutdown']);

    writeFileSync(state, 'stopped');
    writeFileSync(trace, '');
    const reserved = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        SLOT_LIFECYCLE: 'manual',
      },
    });
    assert.notEqual(reserved.status, 0);
    assert.equal(readFileSync(trace, 'utf8'), '');
    assert.equal(readFileSync(state, 'utf8'), 'stopped');

    const stale = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        STALE_FLEET: 'yes',
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.notEqual(stale.status, 0);
    assert.equal(readFileSync(trace, 'utf8'), '');
    assert.equal(readFileSync(state, 'utf8'), 'stopped');

    const occupied = spawnSync('sh', [readinessScript, 'mini-mm-2', '7801'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BOOT_STATE: state,
        TRACE: trace,
        LEASE_HELD: 'yes',
        SLOT_LIFECYCLE: 'ready',
      },
    });
    assert.notEqual(occupied.status, 0);
    assert.equal(readFileSync(trace, 'utf8'), '');
    assert.equal(readFileSync(state, 'utf8'), 'stopped');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
