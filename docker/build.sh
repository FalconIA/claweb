#!/usr/bin/env bash
# Usage (run from project root):
#   ./docker/build.sh                      # build linux/amd64,linux/arm64 (default)
#   ./docker/build.sh linux/amd64          # single platform
#   ./docker/build.sh linux/amd64,linux/arm64,linux/arm/v7   # custom list
#
# The script pushes to Docker Hub by default.
# Set PUSH=0 to load a single-platform image into the local daemon instead:
#   PUSH=0 ./docker/build.sh linux/amd64

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── resolve version from access/frontdoor/package.json ───────────────────────
PACKAGE_JSON="${ROOT_DIR}/access/frontdoor/package.json"
if ! command -v node &>/dev/null; then
  echo "ERROR: node is required to read version from access/frontdoor/package.json" >&2
  exit 1
fi
VERSION="$(node -p "require('${PACKAGE_JSON}').version")"
if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not read version from ${PACKAGE_JSON}" >&2
  exit 1
fi

IMAGE="falconia/claweb-frontdoor:${VERSION}"
PLATFORMS="${1:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"

echo "Building ${IMAGE} for ${PLATFORMS}"

# ── decide load vs push ───────────────────────────────────────────────────────
# --load only works for a single platform; --push works for multi-platform.
PLATFORM_COUNT="$(echo "${PLATFORMS}" | tr ',' '\n' | grep -c .)"

if [[ "${PUSH}" == "0" ]]; then
  if [[ "${PLATFORM_COUNT}" -gt 1 ]]; then
    echo "ERROR: PUSH=0 (--load) only supports a single platform. Specify one platform as argument." >&2
    exit 1
  fi
  OUTPUT_FLAG="--load"
else
  OUTPUT_FLAG="--push"
fi

# ── build ─────────────────────────────────────────────────────────────────────
docker buildx build \
  --platform "${PLATFORMS}" \
  --file "${SCRIPT_DIR}/Dockerfile" \
  --tag "${IMAGE}" \
  ${OUTPUT_FLAG} \
  "${ROOT_DIR}"

echo "Done: ${IMAGE} (${PLATFORMS})"
