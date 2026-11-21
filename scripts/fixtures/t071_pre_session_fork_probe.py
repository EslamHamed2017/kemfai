#!/usr/bin/env python3
"""Deterministic pre-session fork probe for lifecycle cleanup regression tests."""
import os
import pathlib
import signal
import sys
import time

ready = pathlib.Path(sys.argv[1])
child_file = pathlib.Path(sys.argv[2])


def fork_child(_signum, _frame):
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGUSR1, signal.SIG_IGN)
        time.sleep(30)
        os._exit(0)
    child_file.write_text(f"{child}\n")


signal.signal(signal.SIGUSR1, fork_child)
ready.write_text(f"{os.getpid()}\n")
while True:
    signal.pause()
