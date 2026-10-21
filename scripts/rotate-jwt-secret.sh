#!/usr/bin/env bash
#
# Zero-downtime JWT_SECRET rotation helper.
#
# This script does NOT modify any files or running services. It generates a
# new secret and prints the exact commands the operator needs to run. The
# operator reviews the output, updates the environment, and restarts the
# backend when they're ready.
#
# Full procedure: docs/ops/secrets-rotation.md
# Closes #754
#
set -euo pipefail

OLD_SECRET="${JWT_SECRET:-}"
NEW_SECRET=$(openssl rand -base64 64 | tr -d '\n')

echo "==============================================================="
echo " JWT_SECRET rotation helper"
echo "==============================================================="
echo
echo "Generated new JWT_SECRET (${#NEW_SECRET} chars):"
echo "  $NEW_SECRET"
echo
echo "------ Step 1: Update .env -----------------------------------"
echo "Add these two lines to your backend .env (replace the existing"
echo "JWT_SECRET line):"
echo
if [[ -n "$OLD_SECRET" ]]; then
  echo "  JWT_SECRET_PREVIOUS=$OLD_SECRET"
else
  echo "  # JWT_SECRET_PREVIOUS=<old value from current .env>"
  echo "  # (script could not read current JWT_SECRET — set it manually)"
fi
echo "  JWT_SECRET=$NEW_SECRET"
echo
echo "------ Step 2: Restart backend -------------------------------"
echo "  docker compose restart wrfcoin-backend"
echo
echo "------ Step 3: Verify rotation -------------------------------"
echo "Watch the security log for 'JWT verified with previous key'"
echo "messages — these confirm dual-key fallback is working:"
echo "  docker compose logs -f wrfcoin-backend | grep -i 'previous key'"
echo
echo "------ Step 4: After token TTL expires -----------------------"
echo "Wait the longest JWT TTL currently in use (default 24h). When"
echo "no more 'previous key' log lines appear for several hours, the"
echo "rotation is complete:"
echo
echo "  1) Remove JWT_SECRET_PREVIOUS from .env"
echo "  2) docker compose restart wrfcoin-backend"
echo "  3) Archive the old secret to your vault with timestamp"
echo
echo "==============================================================="
echo "IMPORTANT: this script did NOT modify any files."
echo "The operator must apply the steps above manually."
echo "==============================================================="
