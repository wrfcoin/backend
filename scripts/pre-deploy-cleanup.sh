#!/usr/bin/env bash
set -euo pipefail

# pre-deploy-cleanup.sh — safe cleanup of stale .claude/worktrees/ gitlinks
# and dead git-worktree refs before git pull / deploy.
#
# Background: backend#713 — sprint agents create worktrees under
# .claude/worktrees/ that git tracks as gitlink entries (mode 160000).
# When these worktrees are abandoned or manually deleted without
# `git worktree remove`, the checkout becomes dirty:
#   modified: .claude/worktrees/agent-*  (still exists, has changes)
#   deleted:  .claude/worktrees/agent-*  (directory removed, ref orphaned)
# Both block `git pull` until resolved.
#
# Usage:
#   bash scripts/pre-deploy-cleanup.sh           # dry-run: audit only
#   bash scripts/pre-deploy-cleanup.sh --fix     # apply safe cleanups
#
# Safety rules:
#   - Never runs git restore / git clean -fd
#   - Dirty worktrees (uncommitted changes) are reported as errors and skipped
#   - Only targeted `git rm --cached` and `git worktree remove` are applied
#   - .claude/ handoff files and settings.json are never touched

REPO_ROOT="$(git rev-parse --show-toplevel)"
FIX=false
ERRORS=0
WARNINGS=0

for arg in "$@"; do
  case "$arg" in
    --fix) FIX=true ;;
    *) printf 'Unknown argument: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

log_info()  { printf '  INFO  %s\n' "$*"; }
log_warn()  { printf '  WARN  %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
log_error() { printf '  ERROR %s\n' "$*" >&2; ERRORS=$((ERRORS + 1)); }
log_fix()   { printf '  FIX   %s\n' "$*"; }
log_dry()   { printf '  DRY   (would) %s\n' "$*"; }

printf '=== pre-deploy-cleanup: backend main checkout hygiene ===\n'
printf '    repo: %s\n' "$REPO_ROOT"
if $FIX; then
  printf '    mode: FIX (applying changes)\n'
else
  printf '    mode: DRY RUN (pass --fix to apply)\n'
fi
printf '\n'

# ── Step 1: prune dead git worktree reference files ──────────────────────────
printf '── Step 1: git worktree prune ──────────────────────────────\n'
PRUNE_OUT=$(git -C "$REPO_ROOT" worktree prune --dry-run 2>&1 || true)
if [ -n "$PRUNE_OUT" ]; then
  log_info "stale worktree refs found:"
  printf '%s\n' "$PRUNE_OUT" | sed 's/^/    /'
  if $FIX; then
    git -C "$REPO_ROOT" worktree prune
    log_fix "git worktree prune applied"
  else
    log_dry "git worktree prune"
  fi
else
  log_info "no stale worktree refs"
fi
printf '\n'

# ── Step 2: audit .claude/worktrees/ gitlinks in the git index ───────────────
printf '── Step 2: .claude/worktrees/ gitlink audit ────────────────\n'
GITLINKS=$(git -C "$REPO_ROOT" ls-files -s '.claude/worktrees/' 2>/dev/null \
  | awk '$1 == "160000" {print $4}' \
  | grep -E '^\.claude/worktrees/agent-' || true)

if [ -z "$GITLINKS" ]; then
  log_info "no agent gitlinks in index"
else
  while IFS= read -r rel_path; do
    abs_path="$REPO_ROOT/$rel_path"

    if [ ! -d "$abs_path" ]; then
      # Directory is gone — dead gitlink, safe to remove from index
      log_warn "dead gitlink (directory missing): $rel_path"
      if $FIX; then
        git -C "$REPO_ROOT" rm --cached "$rel_path"
        log_fix "git rm --cached $rel_path"
      else
        log_dry "git rm --cached $rel_path"
      fi
    elif [ ! -e "$abs_path/.git" ]; then
      # Directory exists but has no .git — empty gitlink checkout, not a real worktree
      log_warn "gitlink directory has no .git (empty checkout): $rel_path"
      if $FIX; then
        rmdir "$abs_path" 2>/dev/null || true
        git -C "$REPO_ROOT" rm --cached "$rel_path" 2>/dev/null || true
        log_fix "removed empty directory + gitlink: $rel_path"
      else
        log_dry "rmdir $abs_path && git rm --cached $rel_path"
      fi
    else
      # Real git worktree — check for uncommitted changes before touching
      DIRTY=$(git -C "$abs_path" --no-pager status --porcelain 2>/dev/null || echo "__ERROR__")
      if [ "$DIRTY" = "__ERROR__" ]; then
        log_warn "could not read status of $rel_path — skipping"
      elif [ -n "$DIRTY" ]; then
        log_error "DIRTY worktree — must be resolved before deploy: $rel_path"
        printf '%s\n' "$DIRTY" | head -10 | sed 's/^/      /'
        printf '      Resolve: identify which sprint agent owns this worktree,\n'
        printf '      commit or discard changes, then re-run with --fix.\n'
      else
        log_info "clean worktree: $rel_path"
        if $FIX; then
          git -C "$REPO_ROOT" worktree remove --force "$abs_path"
          git -C "$REPO_ROOT" rm --cached "$rel_path" 2>/dev/null || true
          log_fix "removed worktree + gitlink: $rel_path"
        else
          log_dry "git worktree remove --force $abs_path && git rm --cached $rel_path"
        fi
      fi
    fi
  done <<< "$GITLINKS"
fi
printf '\n'

# ── Step 3: delegate untracked source file check ─────────────────────────────
printf '── Step 3: untracked source files ──────────────────────────\n'
UNTRACKED_SCRIPT="$REPO_ROOT/scripts/check-untracked-sources.cjs"
if [ -f "$UNTRACKED_SCRIPT" ]; then
  if ! node "$UNTRACKED_SCRIPT" 2>&1; then
    ERRORS=$((ERRORS + 1))
  fi
else
  log_info "check-untracked-sources.cjs not found — skipping"
fi
printf '\n'

# ── Summary ───────────────────────────────────────────────────────────────────
printf '── Summary ──────────────────────────────────────────────────\n'
if [ "$ERRORS" -gt 0 ]; then
  printf '  FAILED — %d error(s), %d warning(s)\n' "$ERRORS" "$WARNINGS"
  printf '  Resolve errors above before running git pull / deploy.\n'
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  printf '  WARNINGS — %d warning(s) (no blocking errors)\n' "$WARNINGS"
  if ! $FIX; then
    printf '  Re-run with --fix to apply safe cleanups.\n'
  fi
  exit 0
else
  printf '  CLEAN — checkout is ready for git pull / deploy\n'
  exit 0
fi
