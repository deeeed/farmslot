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

import os
import pty
import subprocess
import sys


def main(argv: list[str]) -> int:
    if not argv:
        print("pty-run.py: no command given", file=sys.stderr)
        return 2
    master, slave = pty.openpty()
    try:
        child = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=slave,
            stderr=slave,
            close_fds=True,
        )
    finally:
        os.close(slave)
    chunks = []
    while True:
        try:
            data = os.read(master, 65536)
        except OSError:
            # The child closed the pty; a read on the master then raises EIO.
            break
        if not data:
            break
        chunks.append(data)
    os.close(master)
    sys.stdout.buffer.write(b"".join(chunks))
    sys.stdout.buffer.flush()
    return child.wait()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
