#!/usr/bin/env python3
"""Create a direct owned session with an orphaned same-session descendant."""
import os
import pathlib
import sys
import time

if len(sys.argv) != 2:
    raise SystemExit("usage: t071_direct_session_orphan.py READY_FILE")
ready = pathlib.Path(sys.argv[1])
os.setsid()
intermediate = os.fork()
if intermediate == 0:
    descendant = os.fork()
    if descendant == 0:
        # Publish only after reparenting outside the authenticated leader's ancestry.
        while os.getppid() == intermediate:
            time.sleep(0.01)
        ready.write_text(f"{os.getpid()} {os.getppid()}\n")
        time.sleep(30)
        os._exit(0)
    os._exit(0)
os.waitpid(intermediate, 0)
time.sleep(30)
