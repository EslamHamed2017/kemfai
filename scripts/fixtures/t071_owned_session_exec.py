#!/usr/bin/env python3
"""Supervise an owned service tree for its complete descendant lifetime."""
import ctypes
import os
import pathlib
import signal
import sys
import time


def process_parentage() -> dict[int, int]:
    """Return a race-tolerant PID-to-parent snapshot from procfs."""
    found: dict[int, int] = {}
    for stat in pathlib.Path("/proc").glob("[0-9]*/stat"):
        try:
            raw = stat.read_bytes()
            fields = raw[raw.rfind(b")") + 2 :].split()
            if len(fields) >= 2:
                found[int(stat.parent.name)] = int(fields[1])
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            pass
    return found


def descendants(root: int) -> list[int]:
    """Return the complete live process tree rooted below ``root``."""
    parents = process_parentage()
    owned = {root}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in owned and pid not in owned:
                owned.add(pid)
                changed = True
    owned.discard(root)
    return sorted(owned)


def enable_child_subreaper() -> None:
    """Keep orphaned service descendants parented beneath this supervisor."""
    pr_set_child_subreaper = 36
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(pr_set_child_subreaper, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def reap_adopted_children() -> None:
    """Reap any exited descendants adopted through subreaper ownership."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


FORWARDED_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
previous_signal_mask = signal.pthread_sigmask(signal.SIG_BLOCK, FORWARDED_SIGNALS)

os.setsid()
enable_child_subreaper()
args = sys.argv[1:]
keep = {"PATH", "HOME", "PLAYWRIGHT_BROWSERS_PATH"}
if len(args) >= 2 and args[0] == "--keep-env":
    keep.update(filter(None, args[1].split(",")))
    args = args[2:]
if len(args) >= 2 and args[0] == "--cwd":
    os.chdir(args[1])
    args = args[2:]
if not args:
    raise SystemExit(
        "usage: t071_owned_session_exec.py [--keep-env NAMES] "
        "[--cwd DIR] COMMAND [ARG ...]"
    )
for name in tuple(os.environ):
    if name not in keep:
        del os.environ[name]

# Children can report the stable, registered supervisor identity to readiness
# consumers without confusing it with their own service PID.
os.environ["KEMFAI_OWNED_SESSION_LEADER"] = str(os.getpid())
service_pid = os.fork()
if service_pid == 0:
    signal.pthread_sigmask(signal.SIG_SETMASK, previous_signal_mask)
    os.execvp(args[0], args)
try:
    service_pidfd = os.pidfd_open(service_pid)
except ProcessLookupError:
    # An already-exited child remains waitable and cannot have its PID reused.
    service_pidfd = None


def forward_service_signal(signum: int, _frame: object) -> None:
    pidfd = service_pidfd
    if pidfd is None:
        return
    try:
        signal.pidfd_send_signal(pidfd, signum)
    except ProcessLookupError:
        pass


for forwarded_signal in FORWARDED_SIGNALS:
    signal.signal(forwarded_signal, forward_service_signal)
signal.pthread_sigmask(signal.SIG_SETMASK, previous_signal_mask)

service_status = None
while service_status is None:
    try:
        reaped_pid, reaped_status = os.waitpid(-1, os.WNOHANG)
    except InterruptedError:
        continue
    if reaped_pid == service_pid:
        service_status = reaped_status
    elif reaped_pid == 0:
        time.sleep(0.05)
pidfd_to_close, service_pidfd = service_pidfd, None
if pidfd_to_close is not None:
    os.close(pidfd_to_close)

# As a child subreaper, the authenticated leader remains an ancestor of descendants
# even if they create another session or their intermediate parent exits. Keep a
# bounded empty-tree handoff window so authenticated cleanup can observe the leader
# as the sole remaining member rather than racing its natural exit.
empty_since = None
while True:
    reap_adopted_children()
    if descendants(os.getpid()):
        empty_since = None
    elif empty_since is None:
        empty_since = time.monotonic()
    elif time.monotonic() - empty_since >= 0.5:
        break
    time.sleep(0.05)

service_exit = os.waitstatus_to_exitcode(service_status)
raise SystemExit(service_exit if service_exit >= 0 else 128 - service_exit)
