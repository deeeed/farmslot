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

# Grace period before escalating from SIGTERM to SIGKILL on the child group.
TERMINATE_GRACE_SECONDS = 5


def terminate_group(child: subprocess.Popen) -> None:
    """Kill the child and everything it spawned.

    The command here is `tsx <entry>`, which itself spawns node. A caller such as
    Node's `spawnSync` enforces its timeout by signalling this process only, so
    killing just `child` would leave that node process running against the live
    gateway. The child runs in its own session, so one `killpg` reaches the whole
    tree.
    """
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        child.wait(timeout=TERMINATE_GRACE_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    child.wait()


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
