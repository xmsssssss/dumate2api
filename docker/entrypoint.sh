#!/bin/bash
set -Eeuo pipefail

if [[ "$(id -u)" == "0" ]]; then
  mkdir -p "${DUMATE_ADMIN_DATA}"
  chown -R node:node "${DUMATE_ADMIN_DATA}"
  exec gosu node "$0" "$@"
fi

umask 077
mkdir -p "${DUMATE_ADMIN_DATA}"

gateway_pid=
admin_pid=

shutdown() {
  local status="${1:-0}"
  trap - TERM INT

  if [[ -n "${admin_pid}" ]]; then
    kill -TERM "${admin_pid}" 2>/dev/null || true
  fi
  if [[ -n "${gateway_pid}" ]]; then
    kill -TERM "${gateway_pid}" 2>/dev/null || true
  fi

  wait "${admin_pid}" 2>/dev/null || true
  wait "${gateway_pid}" 2>/dev/null || true
  exit "${status}"
}

trap 'shutdown 143' TERM
trap 'shutdown 130' INT

node src/server.js &
gateway_pid=$!

node src/admin/server.js &
admin_pid=$!

echo "[supervisor] gateway pid=${gateway_pid}, admin pid=${admin_pid}"

set +e
wait -n "${gateway_pid}" "${admin_pid}"
status=$?
set -e

echo "[supervisor] child exited with status ${status}; stopping the other process"
shutdown "${status}"
