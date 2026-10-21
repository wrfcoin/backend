#!/usr/bin/env bash
# Runs __tests__/weather-ipfs-archive-real-node.test.ts against a DISPOSABLE local Kubo and the real storage-node.
# Needs: docker (local images only), the built storage-providers `storage-node` binary in STORAGE_NODE_BIN.
# The Kubo container is created here (exact generated name), published on 127.0.0.1 only, runs --offline with its
# own repo directory, and is removed by that exact name on exit. Nothing else is started, pushed or touched.
set -euo pipefail
: "${STORAGE_NODE_BIN:?set STORAGE_NODE_BIN to the built storage-providers storage-node binary}"
[[ -x $STORAGE_NODE_BIN ]] || { echo "STOP: STORAGE_NODE_BIN is not executable" >&2; exit 1; }
image=ipfs/kubo:v0.24.0
docker image inspect "$image" >/dev/null 2>&1 || { echo "STOP: $image is not present locally (no automatic pull)" >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%S)-$$
name="wrfcoin-archive-e2e-kubo-$stamp"
repo=$(mktemp -d)
port=${KUBO_E2E_PORT:-5101}
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$repo"; }
trap cleanup EXIT
docker run -d --name "$name" -p "127.0.0.1:${port}:5001" -v "$repo:/data/ipfs" "$image" daemon --offline --migrate=true >/dev/null
for _ in $(seq 1 60); do
  curl -sf -X POST "http://127.0.0.1:${port}/api/v0/version" >/dev/null && break
  sleep 1
done
curl -sf -X POST "http://127.0.0.1:${port}/api/v0/version" >/dev/null || { echo "STOP: Kubo did not start" >&2; exit 1; }
KUBO_API="http://127.0.0.1:${port}" STORAGE_NODE_BIN="$STORAGE_NODE_BIN" \
  npx jest --config __tests__/jest.standalone.cjs __tests__/weather-ipfs-archive-real-node.test.ts "$@"
