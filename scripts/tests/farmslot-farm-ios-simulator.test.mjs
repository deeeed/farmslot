import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectPath = fileURLToPath(
  new URL('../../projects/farmslot-farm/project.json', import.meta.url),
);
const project = JSON.parse(readFileSync(projectPath, 'utf8'));
const bootHook = project.resources['ios-sim'].hooks.boot.replaceAll('{{simulator}}', 'fs-2');
const readinessScript = fileURLToPath(
  new URL('../runner-validation/simulator-boot-readiness.sh', import.meta.url),
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
  assert.ok(readinessRecipe.workflow.nodes.boot.timeout_ms >= 480_000);
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
    printf '{"fleet":{"slots":[{"slot":"mini-mm-2","lifecycle":"%s","currentRunId":null,"agent":"idle"}]}}\\n' "$SLOT_LIFECYCLE" ;;
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
  resource.control)
    case "$4" in
      *'"action":"boot"'*) printf 'booted' > "$BOOT_STATE"; printf 'boot\\n' >> "$TRACE" ;;
      *'"action":"shutdown"'*) printf 'stopped' > "$BOOT_STATE"; printf 'shutdown\\n' >> "$TRACE" ;;
    esac
    printf '{"ok":true,"detail":"simulator output"}\\n' ;;
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
