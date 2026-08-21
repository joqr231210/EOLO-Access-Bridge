#!/bin/sh
set -eu

export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-8080}"
export DATA_DIR="${DATA_DIR:-/app/data}"
export UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"

export ANPR_API_PORT="${ANPR_API_PORT:-8090}"
export ANPR_CONTROL_BASE_URL="${ANPR_CONTROL_BASE_URL:-http://127.0.0.1:${ANPR_API_PORT}}"
export ANPR_API_BASE_URL="${ANPR_API_BASE_URL:-http://127.0.0.1:${ANPR_API_PORT}}"
export ANPR_STREAM_PUBLIC_URL="${ANPR_STREAM_PUBLIC_URL:-http://localhost:8083}"

export ANPR_DATA_DIR="${ANPR_DATA_DIR:-${DATA_DIR}/anpr}"
export ANPR_DB_FILE="${ANPR_DB_FILE:-${ANPR_DATA_DIR}/plates.db}"
export ANPR_CONFIG_FILE="${ANPR_CONFIG_FILE:-${ANPR_DATA_DIR}/config.json}"
export ANPR_DETECTIONS_FILE="${ANPR_DETECTIONS_FILE:-${ANPR_DATA_DIR}/anpr-detections.json}"
export ANPR_STATUS_FILE="${ANPR_STATUS_FILE:-${ANPR_DATA_DIR}/anpr-status.json}"
export ANPR_SNAPSHOT_DIR="${ANPR_SNAPSHOT_DIR:-${ANPR_DATA_DIR}/anpr-snapshots}"
export ANPR_STREAM_DIR="${ANPR_STREAM_DIR:-/app/AnprEolo/stream}"

mkdir -p "${DATA_DIR}" "${UPLOAD_DIR}" "${ANPR_DATA_DIR}" "${ANPR_SNAPSHOT_DIR}" /app/AnprEolo/static/captures

if [ ! -f "${ANPR_CONFIG_FILE}" ]; then
  cp /app/AnprEolo/config.default.json "${ANPR_CONFIG_FILE}"
fi

if [ ! -f "${ANPR_DETECTIONS_FILE}" ]; then
  printf '{}\n' > "${ANPR_DETECTIONS_FILE}"
fi

if [ ! -f "${ANPR_STATUS_FILE}" ]; then
  printf '{}\n' > "${ANPR_STATUS_FILE}"
fi

shutdown() {
  if [ -n "${BRIDGE_PID:-}" ] && kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    kill "${BRIDGE_PID}" 2>/dev/null || true
  fi
  if [ -n "${ANPR_PID:-}" ] && kill -0 "${ANPR_PID}" 2>/dev/null; then
    kill "${ANPR_PID}" 2>/dev/null || true
  fi
  wait || true
}

trap shutdown TERM INT

cd /app/AnprEolo
gunicorn --config gunicorn_config.py web_config:app &
ANPR_PID=$!

cd /app
node src/server.js &
BRIDGE_PID=$!

while kill -0 "${ANPR_PID}" 2>/dev/null && kill -0 "${BRIDGE_PID}" 2>/dev/null; do
  sleep 2
done

EXIT_CODE=1
shutdown
exit "${EXIT_CODE}"
