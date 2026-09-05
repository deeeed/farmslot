#!/usr/bin/env python3
"""Run a command with a real pseudo-terminal on stdout, and relay its output.

The farmslot CLI switches to its machine envelope whenever stdout is not a TTY,
so a scenario that captures stdout through a pipe can only ever observe JSON.
Proving what an operator actually reads needs a pty.

`script(1)` cannot do this here: it calls tcgetattr on its own stdin, which a
headless validation harness does not have. This opens a pty for the child's
stdout only and never touches the caller's stdin, so it works with no
controlling terminal at all.

usage: pty-run.py <command> [args...]
Exits with the child's exit status; its combined output goes to stdout.
"""

import errno
import os
import pty
import signal
import subprocess
import sys
import time

# Grace period before escalating from SIGTERM to SIGKILL on the child group.
TERMINATE_GRACE_SECONDS = 5


def _group_alive(pgid: int) -> bool:
    """Whether any process is still in the group. Signal 0 only probes."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Something is there; this process just may not signal it.
        return True
    return True


def terminate_group(child: subprocess.Popen) -> None:
    """Kill the child and everything it spawned, and wait for the group to go.

    The command here is `tsx <entry>`, which itself spawns node. A caller such as
    Node's `spawnSync` enforces its timeout by signalling this process only, so
    killing just `child` would leave that node process running against the live
    gateway. The child runs in its own session, so one `killpg` reaches the tree.

    Reaping the direct child is NOT the end condition. A descendant that ignores
    SIGTERM outlives its parent, so returning once `child.wait()` came back left
    exactly the orphan this function exists to prevent. The group itself has to
    be observed empty, escalating to SIGKILL, and the wait is bounded so a
    process that cannot be killed at all reports rather than hanging.
    """
    pgid = child.pid
    for signal_number in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, signal_number)
        except (ProcessLookupError, PermissionError):
            break
        deadline = time.monotonic() + TERMINATE_GRACE_SECONDS
        while time.monotonic() < deadline:
            # Reap the direct child so it cannot linger as a zombie in the group.
            try:
                child.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                pass
            if not _group_alive(pgid):
                return
        # Still alive after the grace period: escalate to SIGKILL.
    if _group_alive(pgid):
        print(
            f"pty-run.py: process group {pgid} survived SIGTERM and SIGKILL",
            file=sys.stderr,
        )


def main(argv: list[str]) -> int:
    if not argv:
        print("pty-run.py: no command given", file=sys.stderr)
        return 2
    # Fail closed: without a pty the child would fall back to its machine
    # envelope, and a caller checking human output would silently assert on the
    # wrong thing. Let the OSError propagate rather than degrading to a pipe.
    master, slave = pty.openpty()
    try:
        child = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=slave,
            stderr=slave,
            close_fds=True,
            # Own session, so the whole tree can be signalled as one group.
            start_new_session=True,
        )
    finally:
        os.close(slave)

    def on_signal(signum: int, _frame: object) -> None:
        terminate_group(child)
        # Report the signal the way a shell does, so a timeout is not mistaken
        # for the child exiting cleanly.
        os._exit(128 + signum)

    for caught in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(caught, on_signal)

    chunks = []
    try:
        while True:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                # A pty master raises EIO once the last slave fd is closed, which
                # is this platform's end-of-file. Every other errno — EBADF from a
                # closed master, EFAULT, and so on — is a real failure. Treating
                # them all as EOF once returned a clean exit 0 with truncated
                # output, so anything but EIO propagates.
                if error.errno != errno.EIO:
                    terminate_group(child)
                    raise
                break
            if not data:
                break
            chunks.append(data)
    finally:
        os.close(master)
    sys.stdout.buffer.write(b"".join(chunks))
    sys.stdout.buffer.flush()
    return child.wait()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
