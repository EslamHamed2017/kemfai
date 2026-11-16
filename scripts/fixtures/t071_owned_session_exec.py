#!/usr/bin/env python3
"""Supervise an owned service session for its complete descendant lifetime."""
import os
import pathlib
import signal
import sys
import time


def session_members(session: int) -> list[int]:
    """Return live process IDs still attached to the immutable session."""
    found: list[int] = []
    for stat in pathlib.Path("/proc").glob("[0-9]*/stat"):
        try:
            raw = stat.read_bytes()
            fields = raw[raw.rfind(b")") + 2 :].split()
            if len(fields) >= 4 and int(fields[3]) == session:
                found.append(int(stat.parent.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            pass
    return found


FORWARDED_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
previous_signal_mask = signal.pthread_sigmask(signal.SIG_BLOCK, FORWARDED_SIGNALS)

os.setsid()
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

# Children can report the stable, registered session identity to readiness
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

while True:
    try:
        _, service_status = os.waitpid(service_pid, 0)
        break
    except InterruptedError:
        continue
pidfd_to_close, service_pidfd = service_pidfd, None
if pidfd_to_close is not None:
    os.close(pidfd_to_close)

# Keep the authenticated session leader alive while orphaned service descendants
# remain. This preserves the ownership proof required by pidfd-based cleanup.
while any(pid != os.getpid() for pid in session_members(os.getpid())):
    time.sleep(0.05)

service_exit = os.waitstatus_to_exitcode(service_status)
raise SystemExit(service_exit if service_exit >= 0 else 128 - service_exit)
