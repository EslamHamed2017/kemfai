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

adopt_owned_session_transition() {
  local pid="$1" expected_start="$2" identity start session
  identity="$(process_identity "$pid" 2>/dev/null)" || return 1
  read -r start session <<<"$identity"
  [ "$start" = "$expected_start" ] && [ "$session" = "$pid" ] || return 1
  printf '%s\n' "$session"
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
            if session == str(pid):
                signal.pidfd_send_signal(pidfd, signal.SIGCONT)
                resume_needed = False
                raise SystemExit(10)
            children = pathlib.Path(
                '/proc', str(pid), 'task', str(pid), 'children'
            ).read_text().strip()
            if children:
                raise RuntimeError(f'pre-session process is not a leaf: {children}')
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

def identity(path):
    raw = path.read_bytes()
    fields = raw[raw.rfind(b')') + 2:].split()
    if len(fields) < 20:
        raise ValueError('short /proc stat record')
    return fields[19].decode('ascii'), fields[3].decode('ascii')

def members():
    opened = []
    try:
        for stat in pathlib.Path('/proc').glob('[0-9]*/stat'):
            pidfd = None
            try:
                start, session = identity(stat)
                if session != expected_session:
                    continue
                pidfd = os.pidfd_open(int(stat.parent.name))
                if identity(stat) != (start, expected_session):
                    os.close(pidfd); pidfd = None
                    continue
                opened.append(pidfd); pidfd = None
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if pidfd is not None:
                    os.close(pidfd)
        return opened
    except BaseException:
        for pidfd in opened:
            os.close(pidfd)
        raise

try:
    leader_fd = os.pidfd_open(leader)
    if identity(pathlib.Path('/proc', str(leader), 'stat')) != (expected_start, expected_session):
        raise RuntimeError('leader identity mismatch')
    for signal_name in ('TERM', 'KILL'):
        for _ in range(25):
            current = members()
            if not current:
                raise SystemExit(10 if forced_kill else 0)
            if signal_name == 'KILL':
                forced_kill = True
            try:
                for pidfd in current:
                    try:
                        signal.pidfd_send_signal(pidfd, getattr(signal, f'SIG{signal_name}'))
                    except ProcessLookupError:
                        # Another signaled member may have already reaped this process.
                        pass
            finally:
                for pidfd in current:
                    os.close(pidfd)
            time.sleep(0.2)
    current = members()
    try:
        if current:
            raise RuntimeError('owned session members survived SIGKILL')
    finally:
        for pidfd in current:
            os.close(pidfd)
    raise SystemExit(10 if forced_kill else 0)
except (AttributeError, FileNotFoundError, IndexError, OSError, ProcessLookupError,
        RuntimeError, UnicodeError, ValueError) as exc:
    print(f'FAIL cleanup: cannot terminate verified owned session: {exc}', file=sys.stderr)
    raise SystemExit(1)
finally:
    if 'leader_fd' in locals():
        os.close(leader_fd)
PY
}

terminate_owned_process_group() {
  local pid="$1" expected_substr="$2" forced_kill_var="${3:-}" session survivors signal_status children declaration identity start current_session
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
    # Registration can time out just before the pinned launcher completes setsid/fork.
    # Re-authenticate around every signal boundary: setsid/fork can happen after any
    # earlier identity or leaf check, and a leader-only signal must never orphan a child.
    session="$(adopt_owned_session_transition "$pid" "${owned_pid_starttime[$pid]:-}" 2>/dev/null)" || session=""
    [ -z "$session" ] || owned_pid_session["$pid"]="$session"
    if [ -z "$session" ]; then
      # Registration pinned the start time but failed before setsid. Open a pidfd before
      # validating the pinned start time, then signal through that stable kernel reference;
      # never signal a reusable positive PID after a separate identity check.
      children="$(python3 - "$pid" <<'PY_CHILDREN'
import pathlib, sys
try:
    print(pathlib.Path('/proc', sys.argv[1], 'task', sys.argv[1], 'children').read_text().strip())
except (FileNotFoundError, ProcessLookupError):
    pass
PY_CHILDREN
)" || { echo "FAIL cleanup: cannot verify pre-session ${expected_substr} process is a leaf: ${pid}" >&2; return 1; }
      if [ -n "$children" ]; then
        session="$(adopt_owned_session_transition "$pid" "${owned_pid_starttime[$pid]:-}" 2>/dev/null)" || session=""
        if [ -z "$session" ]; then
          echo "FAIL cleanup: pre-session ${expected_substr} process violated owned leaf-launch invariant: ${pid} -> ${children}" >&2
          return 1
        fi
        owned_pid_session["$pid"]="$session"
      fi
    fi
    if [ -z "$session" ]; then
      for _ in $(seq 1 25); do
        session="$(adopt_owned_session_transition "$pid" "${owned_pid_starttime[$pid]:-}" 2>/dev/null)" || session=""
        if [ -n "$session" ]; then
          owned_pid_session["$pid"]="$session"
          break
        fi
        if signal_owned_pid "$pid" "${owned_pid_starttime[$pid]:-}" TERM; then
          session="$(adopt_owned_session_transition "$pid" "${owned_pid_starttime[$pid]:-}" 2>/dev/null)" || session=""
          if [ -n "$session" ]; then
            owned_pid_session["$pid"]="$session"
            break
          fi
          sleep 0.2
          continue
        else
          signal_status=$?
          [ "$signal_status" -eq 3 ] && return 0
          echo "FAIL cleanup: cannot signal owned ${expected_substr} pre-session process: ${pid}" >&2
          return 1
        fi
      done
    fi
    if [ -z "$session" ]; then
      if kill_frozen_owned_pre_session "$pid" "${owned_pid_starttime[$pid]:-}"; then
        signal_status=0
      else
        signal_status=$?
      fi
      case "$signal_status" in
        0) [ -z "$forced_kill_var" ] || printf -v "$forced_kill_var" '%s' 1 ;;
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
    if [ -z "$session" ]; then
      for _ in $(seq 1 25); do
        process_identity "$pid" >/dev/null 2>&1 || return 0
        sleep 0.2
      done
      echo "FAIL cleanup: owned ${expected_substr} pre-session process survivor: ${pid}" >&2
      return 1
    fi
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
