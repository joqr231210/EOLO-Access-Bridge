#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANPR_DIR="${ROOT_DIR}/AnprEolo"
VENV_DIR="${ROOT_DIR}/.venv-anpr"
PYTHON_BIN="${PYTHON:-}"

if [ -z "${PYTHON_BIN}" ]; then
  if command -v python3.11 >/dev/null 2>&1; then
    PYTHON_BIN="python3.11"
  else
    PYTHON_BIN="python3"
  fi
fi

if [ ! -d "${VENV_DIR}" ]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/python" -m pip install -r "${ANPR_DIR}/requirements.txt" pyinstaller

cd "${ANPR_DIR}"
"${VENV_DIR}/bin/pyinstaller" --clean --noconfirm anpr-sidecar.spec

mkdir -p "${ROOT_DIR}/dist"
rm -rf "${ROOT_DIR}/dist/anpr-eolo"
cp -R "${ANPR_DIR}/dist/anpr-eolo" "${ROOT_DIR}/dist/anpr-eolo"

echo "ANPR sidecar listo en ${ROOT_DIR}/dist/anpr-eolo"
