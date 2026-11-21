#!/usr/bin/env bash
# Sourced by the generated launcher and its offline regression. The caller supplies
# fail(), owned_pid_starttime and owned_pid_session.
process_identity() {
  python3 - "$1" <<'PY'
import pathlib, sys
raw = pathlib.Path('/proc', sys.argv[1], 'stat').read_text()
fields = raw[raw.rfind(')') + 2:].split()
print(fields[19], fields[3])
PY
}

signal_owned_pid() {
  python3 - "$1" "$2" "$3" <<'PY'
import os, pathlib, signal, sys
pid, expected_start, signal_name = int(sys.argv[1]), sys.argv[2], sys.argv[3]
try:
    pidfd = os.pidfd_open(pid)
except ProcessLookupError:
    raise SystemExit(3)
except (AttributeError, OSError):
    raise SystemExit(2)
try:
    raw = pathlib.Path('/proc', str(pid), 'stat').read_text()
    fields = raw[raw.rfind(')') + 2:].split()
    if fields[19] != expected_start:
        raise SystemExit(3)
    signal.pidfd_send_signal(pidfd, getattr(signal, f'SIG{signal_name}'))
except (FileNotFoundError, ProcessLookupError):
    raise SystemExit(3)
except (AttributeError, OSError, ValueError):
    raise SystemExit(2)
finally:
    os.close(pidfd)
PY
}

kill_frozen_owned_pre_session() {
  python3 - "$1" "$2" <<'PY'
import os, pathlib, signal, sys, time
pid, expected_start = int(sys.argv[1]), sys.argv[2]
stat = pathlib.Path('/proc', str(pid), 'stat')

def identity():
    raw = stat.read_text()
    fields = raw[raw.rfind(')') + 2:].split()
    if len(fields) < 20:
        raise ValueError('short /proc stat record')
    return fields[19], fields[3], fields[0]

try:
    pidfd = os.pidfd_open(pid)
except ProcessLookupError:
    raise SystemExit(3)
except (AttributeError, OSError):
    raise SystemExit(1)
resume_needed = False
try:
    start, _, _ = identity()
    if start != expected_start:
        raise RuntimeError('leader identity mismatch')
    signal.pidfd_send_signal(pidfd, signal.SIGSTOP)
    resume_needed = True
    for _ in range(500):
        try:
            start, session, state = identity()
        except (FileNotFoundError, ProcessLookupError):
            raise SystemExit(3)
        if start != expected_start:
            raise RuntimeError('leader identity changed while freezing')
        if state in ('T', 't'):
            try:
                task_dir = pathlib.Path('/proc', str(pid), 'task')
                tasks = list(task_dir.glob('[0-9]*'))
                if not tasks:
                    time.sleep(0.01)
                    continue
                children = set()
                all_stopped = True
                for task in tasks:
                    task_raw = (task / 'stat').read_text()
                    task_fields = task_raw[task_raw.rfind(')') + 2:].split()
                    if not task_fields or task_fields[0] not in ('T', 't'):
                        all_stopped = False
                        break
                    children.update((task / 'children').read_text().split())
            except (FileNotFoundError, ProcessLookupError):
                # A thread may exit while the group stop is still completing.
                time.sleep(0.01)
                continue
            if not all_stopped:
                time.sleep(0.01)
                continue
            # Revalidate immutable identity and current session after the complete
            # frozen-thread inspection, immediately before choosing cleanup action.
            current_start, current_session, current_state = identity()
            if current_start != expected_start or current_state not in ('T', 't'):
                raise RuntimeError('leader identity or stopped state changed while frozen')
            if current_session == str(pid):
                signal.pidfd_send_signal(pidfd, signal.SIGCONT)
                resume_needed = False
                raise SystemExit(10)
            if children:
                raise RuntimeError(
                    'pre-session process is not a leaf: ' + ' '.join(sorted(children))
                )
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            resume_needed = False
            raise SystemExit(0)
        time.sleep(0.01)
    raise RuntimeError('timed out freezing pre-session process')
except (AttributeError, FileNotFoundError, OSError, ProcessLookupError,
        RuntimeError, UnicodeError, ValueError) as exc:
    print(f'FAIL cleanup: cannot freeze and kill owned pre-session process: {exc}', file=sys.stderr)
    raise SystemExit(1)
finally:
    if resume_needed:
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGCONT)
        except (AttributeError, OSError, ProcessLookupError):
            pass
    os.close(pidfd)
PY
}

register_owned_process() {
  local pid="$1" expected_substr="$2" identity initial_start start session cmdline matched=0
  [ -n "$pid" ] && [ -r "/proc/$pid/stat" ] || fail "cannot register missing ${expected_substr} process"
  identity="$(process_identity "$pid")" || fail "cannot read ${expected_substr} process identity"
  read -r initial_start session <<<"$identity"
  # Pin identity before waiting for the child to complete exec setsid. Cleanup can then
  # terminate this exact positive PID safely even if registration fails before a new
  # owned session exists.
  owned_pid_starttime["$pid"]="$initial_start"
  owned_pid_session["$pid"]=""
  for _ in $(seq 1 50); do
    identity="$(process_identity "$pid" 2>/dev/null)" || true
    if [ -n "$identity" ]; then
      read -r start session <<<"$identity"
      [ "$start" = "$initial_start" ] || fail "${expected_substr} process identity changed during registration"
      if [ "$session" = "$pid" ]; then
        # Record the immutable session as soon as setsid succeeds, before validating the
        # eventual exec marker, so any later failure still cleans the whole owned group.
        owned_pid_session["$pid"]="$session"
        cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" || true
        case "$cmdline" in *"$expected_substr"*) matched=1; break;; esac
      fi
    fi
    sleep 0.02
  done
  [ "$matched" -eq 1 ] || fail "${expected_substr} did not become the expected owned session leader"
}

pid_owned_by_this_run() {
  local pid="$1" expected_substr="$2" identity start session cmdline
  [ -n "$pid" ] && [ -n "${owned_pid_starttime[$pid]:-}" ] && [ -r "/proc/$pid/stat" ] || return 1
  identity="$(process_identity "$pid" 2>/dev/null)" || return 1
  read -r start session <<<"$identity"
  [ "$start" = "${owned_pid_starttime[$pid]}" ] && [ "$session" = "${owned_pid_session[$pid]}" ] || return 1
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" || return 1
  case "$cmdline" in *"$expected_substr"*) return 0;; *) return 1;; esac
}

session_survivors() {
  python3 - "$1" <<'PY'
import pathlib, sys
found = []
for stat in pathlib.Path('/proc').glob('[0-9]*/stat'):
    try:
        raw = stat.read_bytes(); fields = raw[raw.rfind(b')') + 2:].split()
        if fields[3] == sys.argv[1].encode('ascii'): found.append(stat.parent.name)
    except (FileNotFoundError, IndexError, PermissionError, ProcessLookupError, ValueError): pass
print(' '.join(found))
PY
}

terminate_verified_owned_session() {
  python3 - "$1" "$2" "$3" <<'PY'
import os, pathlib, signal, sys, time
leader, expected_start, expected_session = int(sys.argv[1]), sys.argv[2], sys.argv[3]
forced_kill = False
leader_exit_authorized = False


def identity(path):
    raw = path.read_bytes()
    fields = raw[raw.rfind(b')') + 2:].split()
    if len(fields) < 20:
        raise ValueError('short /proc stat record')
    return (
        fields[19].decode('ascii'),
        fields[3].decode('ascii'),
        int(fields[1]),
    )


def open_verified(pid, expected=None):
    pidfd = os.pidfd_open(pid)
    try:
        current = identity(pathlib.Path('/proc', str(pid), 'stat'))
        if expected is not None and current != expected:
            raise ProcessLookupError('process identity changed')
        return pidfd, current
    except BaseException:
        os.close(pidfd)
        raise


def members():
    """Open pidfds by walking only revalidated kernel child relationships."""
    opened = []
    complete = True
    try:
        try:
            leader_fd_local, leader_record = open_verified(leader)
        except ProcessLookupError:
            return [], False
        if leader_record[:2] != (expected_start, expected_session):
            os.close(leader_fd_local)
            raise RuntimeError('leader identity mismatch')
        opened.append((leader, leader_fd_local))
        queue = [(leader, leader_record)]
        seen = {leader}
        while queue:
            parent, parent_record = queue.pop(0)
            parent_stat = pathlib.Path('/proc', str(parent), 'stat')
            task_dir = pathlib.Path('/proc', str(parent), 'task')
            children = set()
            try:
                if identity(parent_stat) != parent_record:
                    complete = False
                    continue
                tasks = list(task_dir.glob('[0-9]*'))
                if not tasks:
                    complete = False
                    continue
            except (FileNotFoundError, ProcessLookupError):
                complete = False
                continue
            for task in tasks:
                try:
                    if identity(parent_stat) != parent_record:
                        complete = False
                        break
                    children.update((task / 'children').read_text().split())
                    if identity(parent_stat) != parent_record:
                        complete = False
                        break
                except (FileNotFoundError, ProcessLookupError):
                    # A thread may exit while its process and other threads stay live.
                    complete = False
            for child_text in children:
                child = int(child_text)
                if child in seen:
                    continue
                child_fd = None
                try:
                    child_fd, child_record = open_verified(child)
                    if child_record[2] != parent:
                        os.close(child_fd); child_fd = None
                        complete = False
                        continue
                    if identity(parent_stat) != parent_record:
                        os.close(child_fd); child_fd = None
                        complete = False
                        continue
                    opened.append((child, child_fd)); child_fd = None
                    seen.add(child)
                    queue.append((child, child_record))
                except (FileNotFoundError, ProcessLookupError):
                    complete = False
                finally:
                    if child_fd is not None:
                        os.close(child_fd)
        return opened, complete
    except BaseException:
        for _, pidfd in opened:
            os.close(pidfd)
        raise


def authenticated_session_members():
    """Open and pin every process in the leader's immutable session."""
    opened = []
    try:
        for stat in pathlib.Path('/proc').glob('[0-9]*/stat'):
            pidfd = None
            try:
                recorded = identity(stat)
                if recorded[1] != expected_session:
                    continue
                pid = int(stat.parent.name)
                pidfd, current = open_verified(pid, recorded)
                # Keep the stat identity used to admit this session member. It is
                # revalidated again immediately before any signal is sent.
                opened.append((pid, pidfd, current)); pidfd = None
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if pidfd is not None:
                    os.close(pidfd)
        return opened
    except BaseException:
        for item in opened:
            os.close(item[1])
        raise


def close_all(opened):
    for item in opened:
        os.close(item[1])


def signal_session_member(member, signum):
    """Signal only a still-pinned member of the authenticated immutable session."""
    pid, pidfd, recorded = member
    current = identity(pathlib.Path('/proc', str(pid), 'stat'))
    if current[:2] != recorded[:2] or current[1] != expected_session:
        raise ProcessLookupError('session member identity changed')
    signal.pidfd_send_signal(pidfd, signum)


try:
    try:
        leader_fd = os.pidfd_open(leader)
    except ProcessLookupError:
        current = authenticated_session_members()
        try:
            if current:
                raise RuntimeError('owned session survived its authenticated leader')
        finally:
            close_all(current)
        raise RuntimeError(
            'authenticated leader missing; process-tree extinction cannot be proven'
        )
    leader_identity = identity(pathlib.Path('/proc', str(leader), 'stat'))
    if leader_identity[:2] != (expected_start, expected_session):
        raise RuntimeError('leader identity mismatch')
    for signal_name in ('TERM', 'KILL'):
        for _ in range(25):
            current, complete = members()
            session_current = authenticated_session_members()
            if not current:
                try:
                    if session_current:
                        raise RuntimeError(
                            'owned session survived its authenticated leader'
                        )
                    if leader_exit_authorized:
                        raise SystemExit(10 if forced_kill else 0)
                    raise RuntimeError(
                        'authenticated leader disappeared during process-tree cleanup'
                    )
                finally:
                    close_all(session_current)
            session_pids = {item[0] for item in session_current}
            session_descendants = [
                item for item in session_current if item[0] != leader
            ]
            # Session members use their separately opened, twice-revalidated pidfds.
            # The ancestry walk remains responsible only for authenticated descendants
            # that deliberately entered a different session.
            tree_descendants = [
                item for item in current
                if item[0] != leader and item[0] not in session_pids
            ]
            signum = getattr(signal, f'SIG{signal_name}')
            if signal_name == 'KILL':
                forced_kill = True
            leader_member = next(
                (item for item in session_current if item[0] == leader), None
            )
            if not session_descendants and not tree_descendants and complete:
                if leader_member is None:
                    close_all(session_current)
                    close_all(current)
                    raise RuntimeError('authenticated session leader was not enumerable')
                leader_exit_authorized = True
                session_targets = [leader_member]
            else:
                session_targets = session_descendants
            try:
                for member in session_targets:
                    try:
                        signal_session_member(member, signum)
                    except (FileNotFoundError, ProcessLookupError):
                        pass
                for _, pidfd in tree_descendants:
                    try:
                        signal.pidfd_send_signal(pidfd, signum)
                    except ProcessLookupError:
                        pass
            finally:
                close_all(session_current)
                close_all(current)
            time.sleep(0.2)
    current, _ = members()
    session_current = authenticated_session_members()
    try:
        if current or session_current:
            raise RuntimeError('owned process-tree or session members survived SIGKILL')
    finally:
        close_all(session_current)
        close_all(current)
    raise SystemExit(10 if forced_kill else 0)
except (AttributeError, FileNotFoundError, IndexError, OSError, ProcessLookupError,
        RuntimeError, UnicodeError, ValueError) as exc:
    print(f'FAIL cleanup: cannot terminate verified owned process tree: {exc}', file=sys.stderr)
    raise SystemExit(1)
finally:
    if 'leader_fd' in locals():
        os.close(leader_fd)
PY
}

terminate_owned_process_group() {
  local pid="$1" expected_substr="$2" forced_kill_var="${3:-}" session signal_status declaration
  if [ -n "$forced_kill_var" ]; then
    if [[ ! "$forced_kill_var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] \
      || ! declaration="$(declare -p "$forced_kill_var" 2>/dev/null)"; then
      echo "FAIL cleanup: invalid forced-kill result variable" >&2
      return 1
    fi
    case "$declaration" in
      'declare -- '*|'declare -i '*) ;;
      *) echo "FAIL cleanup: forced-kill result variable must be a writable scalar" >&2; return 1 ;;
    esac
  fi
  [ -n "$pid" ] || return 0
  session="${owned_pid_session[$pid]:-}"
  if [ -z "$session" ]; then
    # Freeze the exact pidfd-pinned process before deciding whether it has completed
    # the owned-session transition or is still a childless pre-session launcher.
    if kill_frozen_owned_pre_session "$pid" "${owned_pid_starttime[$pid]:-}"; then
      signal_status=0
    else
      signal_status=$?
    fi
    case "$signal_status" in
      0)
        [ -z "$forced_kill_var" ] || printf -v "$forced_kill_var" '%s' 1
        return 0
        ;;
      3) return 0 ;;
      10)
        session="$pid"
        owned_pid_session["$pid"]="$session"
        ;;
      *)
        echo "FAIL cleanup: cannot kill owned ${expected_substr} pre-session process: ${pid}" >&2
        return 1
        ;;
    esac
  fi
  if terminate_verified_owned_session "$pid" "${owned_pid_starttime[$pid]:-}" "$session"; then
    signal_status=0
  else
    signal_status=$?
  fi
  if [ "$signal_status" -eq 10 ]; then
    [ -z "$forced_kill_var" ] || printf -v "$forced_kill_var" '%s' 1
    return 0
  fi
  if [ "$signal_status" -ne 0 ]; then
    echo "FAIL cleanup: could not terminate verified owned ${expected_substr} session" >&2
    return 1
  fi
}
