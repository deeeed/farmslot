# Gateway crash and volume recovery

The shared dev stack supervises `dev-gateway.sh`. An abnormal gateway exit restarts it after 1 second, doubling the delay to at most 30 seconds during repeated failures. A minute of uptime resets the delay. A clean exit stops supervision. Stopping the stack forwards the signal to its gateway process group and cancels retries. Isolated `tsx watch` stacks keep their existing restart owner.

On macOS, file watchers use parent-directory FSEvents. F401 reproduced libuv's native `uv__fs_event` abort when an APFS volume was forcibly detached while a file-inode watcher was armed. Both Chokidar module formats are patched; Copilot's direct watcher uses the same directory boundary. No heap-size change is involved.

A missing local volume disables its slots in the fleet projection and prevents preparation, store creation and writes. The persisted run owner and task paths stay intact. One metadata watcher per configured volume checks its directory once a second. This catches reattachment events FSEvents omits, without rescanning slot trees. Changes publish slot invalidations and log the affected paths. Doctor's Workspace checks name unavailable slot and store volumes. Reconnect the drive; do not recreate its directories on the internal disk. Reattachment restores the existing slot state and data.

Run the isolated process proof on macOS:

```sh
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/runner-validation/storage-volume-smoke.mts /tmp/storage-proof-evidence
```

It owns a temporary APFS image, gateway identity and ephemeral port. It verifies active task writes, forced detach without gateway restart, unavailable slots and Doctor alerts, reattachment with retained bytes, recovery notifications after starting with the volume absent, SIGABRT recovery, and shutdown without a remaining gateway. It removes its image and private stack afterward.
