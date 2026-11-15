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
        raw = stat.read_text(); fields = raw[raw.rfind(')') + 2:].split()
        if fields[3] == sys.argv[1]: found.append(stat.parent.name)
    except (FileNotFoundError, PermissionError, ProcessLookupError): pass
print(' '.join(found))
PY
}

terminate_owned_process_group() {
  local pid="$1" expected_substr="$2" session survivors signal_status children
  [ -n "$pid" ] || return 0
  session="${owned_pid_session[$pid]:-}"
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
      echo "FAIL cleanup: pre-session ${expected_substr} process violated owned leaf-launch invariant: ${pid} -> ${children}" >&2
      return 1
    fi
    for _ in $(seq 1 25); do
      if signal_owned_pid "$pid" "${owned_pid_starttime[$pid]:-}" TERM; then
        sleep 0.2
        continue
      else
        signal_status=$?
        [ "$signal_status" -eq 3 ] && return 0
        echo "FAIL cleanup: cannot signal owned ${expected_substr} pre-session process: ${pid}" >&2
        return 1
      fi
    done
    if signal_owned_pid "$pid" "${owned_pid_starttime[$pid]:-}" KILL; then
      :
    else
      signal_status=$?
      [ "$signal_status" -eq 3 ] && return 0
      echo "FAIL cleanup: cannot kill owned ${expected_substr} pre-session process: ${pid}" >&2
      return 1
    fi
    for _ in $(seq 1 25); do
      process_identity "$pid" >/dev/null 2>&1 || return 0
      sleep 0.2
    done
    echo "FAIL cleanup: owned ${expected_substr} pre-session process survivor: ${pid}" >&2
    return 1
  fi
  if ! pid_owned_by_this_run "$pid" "$expected_substr"; then
    survivors="${session:+$(session_survivors "$session")}" 
    [ -z "$survivors" ] && return 0
    # The registered leader exited but descendants remain in its immutable session.
    # A live process group cannot have its numeric id recycled; signal that original
    # group, never the now-unrelated positive pid.
    kill -TERM -- "-$pid" 2>/dev/null || true
  fi
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    survivors="$(session_survivors "$session")"
    [ -z "$survivors" ] && return 0
    sleep 0.2
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    survivors="$(session_survivors "$session")"
    [ -z "$survivors" ] && return 0
    sleep 0.2
  done
  echo "FAIL cleanup: owned ${expected_substr} session survivor(s): ${survivors}" >&2
  return 1
}
