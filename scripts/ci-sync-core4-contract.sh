#!/usr/bin/env bash
# Sync the persistent per-runner core4 clone used by the core4-http-contract
# CI job (backend#1277, infra#1113 data cap) to the tip of core4 main.
#
# usage: scripts/ci-sync-core4-contract.sh <clone-dir> [remote-url]
#   remote-url defaults to git@github.com:wrfcoin/core4.git; auth comes from
#   the caller's GIT_SSH_COMMAND. CORE4_REF overrides the branch (default main).
#
# Self-healing (#1277 review P2): the clone persists across runs, so a job
# killed mid-fetch or mid-checkout (SIGKILL, reboot, timeout) can leave
# .git/shallow.lock, .git/index.lock or a damaged repo behind. Without this,
# every later run would exit 128 until someone cleaned the build runner by hand. If the
# sync fails for any reason, the clone is deleted and synced from scratch
# ONCE. That costs one full depth=1 clone (~46 MB) and only on that failure
# path. A second failure is a real error (network, auth, missing ref) and
# fails the step.
set -euo pipefail

dir="${1:?usage: $0 <clone-dir> [remote-url]}"
remote="${2:-git@github.com:wrfcoin/core4.git}"
ref="${CORE4_REF:-main}"

sync_once() {
  # Every command is explicit `|| return 1`: sync_once runs inside an `if`
  # condition, where `set -e` is suspended.
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir" || return 1
    git init -q "$dir" || return 1
  fi
  if git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$dir" remote set-url origin "$remote" || return 1
  else
    git -C "$dir" remote add origin "$remote" || return 1
  fi
  git -C "$dir" fetch --no-tags --prune --depth=1 origin \
    "+refs/heads/$ref:refs/remotes/origin/$ref" || return 1
  git -C "$dir" checkout -q --force --detach "refs/remotes/origin/$ref" || return 1
  git -C "$dir" clean -q -ffdx || return 1
}

if ! sync_once; then
  echo "::warning::core4 contract clone at $dir failed to sync (stale lock or damaged repo); deleting it and re-cloning once" >&2
  rm -rf "$dir"
  sync_once
fi

echo "core4 $ref at $(git -C "$dir" rev-parse HEAD) in $dir"
