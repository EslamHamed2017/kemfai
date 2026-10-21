#!/usr/bin/env bash
# Shared fail-closed cleanup for disposable, label-owned Docker test containers.
# Call kemfai_docker_cleanup_init once, register each intended name BEFORE create/run,
# and invoke kemfai_cleanup_owned_containers from the caller's EXIT trap.

kemfai_docker_cleanup_init() {
  KEMFAI_CLEANUP_LABEL_KEY="$1"
  KEMFAI_CLEANUP_RUN_ID="$2"
  KEMFAI_CLEANUP_LABEL="${1}=${2}"
  KEMFAI_CLEANUP_CONTAINER_INTENTS=()
  KEMFAI_CLEANUP_NETWORK_INTENTS=()
}

kemfai_register_network_intent() {
  [ "$#" -eq 1 ] && [ -n "$1" ] || {
    echo "FAIL cleanup: refusing an empty network intent" >&2
    return 1
  }
  KEMFAI_CLEANUP_NETWORK_INTENTS+=("$1")
}

kemfai_register_container_intent() {
  [ "$#" -eq 1 ] && [ -n "$1" ] || {
    echo "FAIL cleanup: refusing an empty container intent" >&2
    return 1
  }
  KEMFAI_CLEANUP_CONTAINER_INTENTS+=("$1")
}

kemfai_exact_owned_network_id() {
  local name="$1" resource_id inspected
  if ! resource_id="$(docker network ls -q --no-trunc --filter "name=^${name}$")"; then
    return 3
  fi
  [ -n "$resource_id" ] || return 1
  case "$resource_id" in *$'\n'*) return 3 ;; esac
  if ! inspected="$(docker network inspect -f "{{.Id}} {{ index .Labels \"${KEMFAI_CLEANUP_LABEL_KEY}\" }}" "$resource_id")"; then
    return 3
  fi
  [ "$inspected" = "${resource_id} ${KEMFAI_CLEANUP_RUN_ID}" ] || return 2
  printf '%s\n' "$resource_id"
}

kemfai_exact_owned_container_id() {
  local name="$1" resource_id inspected
  if ! resource_id="$(docker ps -aq --no-trunc --filter "name=^/${name}$")"; then
    return 3
  fi
  [ -n "$resource_id" ] || return 1
  case "$resource_id" in *$'\n'*) return 3 ;; esac
  if ! inspected="$(docker inspect -f "{{.Id}} {{ index .Config.Labels \"${KEMFAI_CLEANUP_LABEL_KEY}\" }}" "$resource_id")"; then
    return 3
  fi
  [ "$inspected" = "${resource_id} ${KEMFAI_CLEANUP_RUN_ID}" ] || return 2
  printf '%s\n' "$resource_id"
}

# Print the exact volume names which Docker will treat as anonymous for `rm -v`.
# A volume is anonymous only when it is attached to this verified container and its
# source was not explicitly supplied through HostConfig.Binds or HostConfig.Mounts.
# The inspect template intentionally reads mount metadata only (never Config.Env).
kemfai_container_anonymous_volume_ids() {
  local resource_id="$1" metadata
  if ! metadata="$(docker inspect -f '{{json .Mounts}}|{{json .HostConfig.Binds}}|{{json .HostConfig.Mounts}}' "$resource_id")"; then
    return 1
  fi
  python3 -c '
import json, sys
parts = sys.stdin.read().rstrip("\n").split("|", 2)
if len(parts) != 3:
    raise SystemExit(2)
mounts, binds, host_mounts = (json.loads(part or "null") or [] for part in parts)
explicit = set()
for bind in binds:
    source = bind.split(":", 1)[0]
    if source:
        explicit.add(source)
for mount in host_mounts:
    if str(mount.get("Type", "")).lower() == "volume" and mount.get("Source"):
        explicit.add(mount["Source"])
for mount in mounts:
    if mount.get("Type") != "volume":
        continue
    name = mount.get("Name") or mount.get("Source")
    if not isinstance(name, str) or not name or "\n" in name:
        raise SystemExit(2)
    if name not in explicit:
        print(name)
' <<<"$metadata"
}

kemfai_validate_volume_id() {
  local volume_id="$1" inspected
  if ! inspected="$(docker volume inspect -f '{{.Name}}' "$volume_id")"; then
    return 1
  fi
  [ "$inspected" = "$volume_id" ]
}

kemfai_verify_anonymous_volume_absent() {
  local volume_id="$1" listed attached
  # Docker volume names are returned in full by `volume ls -q`; unlike container
  # listing, this command has no portable --no-trunc option.
  if ! listed="$(docker volume ls -q)"; then
    echo "FAIL cleanup: Docker volume listing failed while checking captured anonymous volume '$volume_id'" >&2
    return 1
  fi
  if ! printf '%s\n' "$listed" | grep -Fx -- "$volume_id" >/dev/null; then
    return 0
  fi
  if ! kemfai_validate_volume_id "$volume_id"; then
    echo "FAIL cleanup: captured anonymous volume '$volume_id' survived but its metadata cannot be verified" >&2
    return 1
  fi
  if ! attached="$(docker ps -aq --no-trunc --filter "volume=${volume_id}")"; then
    echo "FAIL cleanup: captured anonymous volume '$volume_id' survived and attachment lookup failed" >&2
    return 1
  fi
  if [ -n "$attached" ]; then
    echo "FAIL cleanup: captured anonymous volume '$volume_id' remains attached elsewhere; preserving it" >&2
  else
    echo "FAIL cleanup: captured anonymous volume '$volume_id' survived removal unexplained; preserving it" >&2
  fi
  return 1
}

kemfai_cleanup_owned_networks() {
  local failed=0 index name resource_id ownership_status survivors
  for ((index=${#KEMFAI_CLEANUP_NETWORK_INTENTS[@]}-1; index>=0; index--)); do
    name="${KEMFAI_CLEANUP_NETWORK_INTENTS[$index]}"
    resource_id="$(kemfai_exact_owned_network_id "$name")"
    ownership_status=$?
    case "$ownership_status" in
      0)
        if ! docker network rm "$resource_id" >/dev/null; then
          echo "FAIL cleanup: could not remove verified network '$name'" >&2
          failed=1
        fi
        ;;
      1) ;;
      2)
        echo "FAIL cleanup: tracked network '$name' has a nonmatching identity/label; not touching it" >&2
        failed=1
        ;;
      *)
        echo "FAIL cleanup: unable to establish ownership of tracked network '$name'; not touching it" >&2
        failed=1
        ;;
    esac
  done
  if ! survivors="$(docker network ls -q --no-trunc --filter "label=${KEMFAI_CLEANUP_LABEL}")"; then
    echo "FAIL cleanup: unable to verify exact-label network cleanup for ${KEMFAI_CLEANUP_LABEL}" >&2
    failed=1
  elif [ -n "$survivors" ]; then
    echo "FAIL cleanup: exact-label network survivor(s) remain for ${KEMFAI_CLEANUP_LABEL}" >&2
    failed=1
  fi
  return "$failed"
}

kemfai_cleanup_owned_resources() {
  local initial_status="$1" cleanup_failed=0
  kemfai_cleanup_owned_containers || cleanup_failed=1
  kemfai_cleanup_owned_networks || cleanup_failed=1
  if [ "$initial_status" -ne 0 ]; then
    return "$initial_status"
  fi
  return "$cleanup_failed"
}

kemfai_cleanup_owned_containers() {
  local failed=0 index name resource_id ownership_status survivors volume_id volume_output
  local -a anonymous_volume_ids=()
  for ((index=${#KEMFAI_CLEANUP_CONTAINER_INTENTS[@]}-1; index>=0; index--)); do
    name="${KEMFAI_CLEANUP_CONTAINER_INTENTS[$index]}"
    resource_id="$(kemfai_exact_owned_container_id "$name")"
    ownership_status=$?
    case "$ownership_status" in
      0)
        anonymous_volume_ids=()
        if ! volume_output="$(kemfai_container_anonymous_volume_ids "$resource_id")"; then
          echo "FAIL cleanup: could not classify mount metadata for verified container '$name'; not touching it" >&2
          failed=1
          continue
        fi
        [ -z "$volume_output" ] || mapfile -t anonymous_volume_ids <<<"$volume_output"
        for volume_id in "${anonymous_volume_ids[@]}"; do
          if ! kemfai_validate_volume_id "$volume_id"; then
            echo "FAIL cleanup: attached anonymous volume '$volume_id' metadata is unavailable or mismatched; not touching container '$name'" >&2
            failed=1
            continue 2
          fi
        done
        # Docker alone performs its documented scoped anonymous-volume cleanup.
        # This helper never invokes `docker volume rm` or any prune operation.
        if ! docker rm -f -v "$resource_id" >/dev/null; then
          echo "FAIL cleanup: could not remove verified container '$name' with anonymous volumes" >&2
          failed=1
          continue
        fi
        for volume_id in "${anonymous_volume_ids[@]}"; do
          kemfai_verify_anonymous_volume_absent "$volume_id" || failed=1
        done
        ;;
      1) ;; # Intent was registered, but create/run never produced a surviving container.
      2)
        echo "FAIL cleanup: tracked container '$name' has a nonmatching identity/label; not touching it" >&2
        failed=1
        ;;
      *)
        echo "FAIL cleanup: unable to establish ownership of tracked container '$name'; not touching it" >&2
        failed=1
        ;;
    esac
  done
  if ! survivors="$(docker ps -aq --no-trunc --filter "label=${KEMFAI_CLEANUP_LABEL}")"; then
    echo "FAIL cleanup: unable to verify exact-label container cleanup for ${KEMFAI_CLEANUP_LABEL}" >&2
    failed=1
  elif [ -n "$survivors" ]; then
    echo "FAIL cleanup: exact-label container survivor(s) remain for ${KEMFAI_CLEANUP_LABEL}" >&2
    failed=1
  fi
  return "$failed"
}

kemfai_install_cleanup_signal_traps() {
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
