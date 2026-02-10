#!/usr/bin/env bash
set -euo pipefail

# Runs a Cloudflare Tunnel connector on this machine and forwards traffic to a local origin.
# Default wiring matches this repo's dev server: http://127.0.0.1:8787
# If the origin is not reachable, this script will start the kernel via `deno task dev`
# (only supported for the default 8787 origin).
#
# Usage:
#   scripts/run-cloudflared-dev.sh
#   scripts/run-cloudflared-dev.sh <tunnel-name> <hostname> <local-url>
#
# Example:
#   scripts/run-cloudflared-dev.sh pi-agent kernel.pavlovcik.com http://127.0.0.1:8787

TUNNEL_NAME="${1:-pi-agent}"
HOSTNAME="${2:-kernel.pavlovcik.com}"
LOCAL_URL="${3:-http://127.0.0.1:8787}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found in PATH. Install it (Homebrew): brew install cloudflared" >&2
  exit 127
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found in PATH." >&2
  exit 127
fi

# Keep token file private on disk.
umask 077
TOKEN_DIR="${HOME}/.cloudflared"
TOKEN_FILE="${TOKEN_DIR}/${TUNNEL_NAME}.token"
mkdir -p "${TOKEN_DIR}"

kernel_pid=""
started_kernel="0"
did_cleanup="0"

cleanup() {
  if [[ "${did_cleanup}" == "1" ]]; then
    return 0
  fi
  did_cleanup="1"

  if [[ "${started_kernel}" == "1" && -n "${kernel_pid}" ]]; then
    echo
    echo "Stopping kernel (PID ${kernel_pid})..."
    kill "${kernel_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Preflight: checking origin is reachable at ${LOCAL_URL} ..."
if curl -fsS --max-time 2 "${LOCAL_URL}/" >/dev/null; then
  echo "Origin OK."
else
  if [[ "${LOCAL_URL}" != "http://127.0.0.1:8787" && "${LOCAL_URL}" != "http://localhost:8787" ]]; then
    echo "Origin is not reachable at ${LOCAL_URL}/." >&2
    echo "This script can only auto-start the kernel on http://127.0.0.1:8787 (deno task dev hard-codes port 8787)." >&2
    echo "Either start the kernel manually for ${LOCAL_URL}, or omit arg #3 to use the default." >&2
    exit 1
  fi

  if ! command -v deno >/dev/null 2>&1; then
    echo "Origin is not reachable at ${LOCAL_URL}/ and deno is not in PATH." >&2
    echo "Either start the kernel first (e.g. deno task dev) or install deno." >&2
    exit 127
  fi

  echo "Origin is not reachable; starting kernel via 'deno task dev'..."
  (
    cd "${REPO_ROOT}"
    deno task dev
  ) &
  kernel_pid="$!"
  started_kernel="1"

  echo "Waiting for origin to become reachable at ${LOCAL_URL} ..."
  for _ in {1..60}; do
    if curl -fsS --max-time 1 "${LOCAL_URL}/" >/dev/null 2>&1; then
      echo "Origin OK."
      break
    fi
    if ! kill -0 "${kernel_pid}" >/dev/null 2>&1; then
      echo "Kernel process exited unexpectedly (PID ${kernel_pid})." >&2
      exit 1
    fi
    sleep 1
  done

  if ! curl -fsS --max-time 2 "${LOCAL_URL}/" >/dev/null; then
    echo "Kernel did not become reachable at ${LOCAL_URL}/ within 60s." >&2
    exit 1
  fi
fi

if [[ ! -s "${TOKEN_FILE}" ]]; then
  echo "Generating tunnel token for '${TUNNEL_NAME}' -> ${TOKEN_FILE}"
  cloudflared tunnel token "${TUNNEL_NAME}" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi

echo "Ensuring DNS route exists: ${HOSTNAME} -> tunnel '${TUNNEL_NAME}'"
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME}" >/dev/null

echo "Starting connector: https://${HOSTNAME} -> ${LOCAL_URL}"
echo "Test in another terminal: curl -i https://${HOSTNAME}/"
cloudflared tunnel run --token-file "${TOKEN_FILE}" --url "${LOCAL_URL}" "${TUNNEL_NAME}"
