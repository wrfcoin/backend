#!/usr/bin/env bash
# core4's vendored crates are today's wire truth; standalone repositories are
# not consumed by the node. This takes no position on their future canonical home.
# Regeneration requires the approved Rust build lane; do not run it locally as
# part of the script-only #1174 repair. CORE4_DIR selects that lane's checkout.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
CORE4_DIR="${CORE4_DIR:-$WORKSPACE_DIR/core4}"
METEO_DIR="$CORE4_DIR/meteo-types"
FORECAST_DIR="$CORE4_DIR/forecast-score"
DEST="$BACKEND_DIR/shared/generated-types"

# Validate both sources before running cargo or touching committed bindings.
for crate in "$METEO_DIR" "$FORECAST_DIR"; do
  if [[ ! -f "$crate/Cargo.toml" ]]; then
    echo "core4 checkout not found or crate missing: $crate/Cargo.toml (set CORE4_DIR)" >&2
    exit 1
  fi
done
# Provenance must name the exact tree: a git checkout is required (a
# `git archive` export has no commit to record), and uncommitted changes are
# recorded as "-dirty".
if ! git -C "$CORE4_DIR" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
  echo "CORE4_DIR is not a git checkout: $CORE4_DIR (provenance needs a real checkout, not an archive export)" >&2
  exit 1
fi
CORE4_SHA="$(git -C "$CORE4_DIR" describe --always --dirty --abbrev=12)"
HAND_MAINTAINED_LIST="$DEST/hand-maintained.txt"
GENERATED_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$GENERATED_ROOT"' EXIT

# ts-rs defaults to ./bindings plus each #[ts(export_to = "bindings/")].
# Set the base explicitly so stale crate output or caller env cannot be copied.
echo "==> Generating core4 $CORE4_SHA meteo-types bindings..."
(cd "$METEO_DIR" && TS_RS_EXPORT_DIR="$GENERATED_ROOT/meteo" cargo test --features ts --quiet)
echo "==> Generating core4 $CORE4_SHA forecast-score bindings..."
(cd "$FORECAST_DIR" && TS_RS_EXPORT_DIR="$GENERATED_ROOT/forecast" cargo test --features ts --quiet)
shopt -s nullglob
meteo_files=("$GENERATED_ROOT/meteo/bindings/"*.ts)
forecast_files=("$GENERATED_ROOT/forecast/bindings/"*.ts)
if (( ${#meteo_files[@]} == 0 || ${#forecast_files[@]} == 0 )); then
  echo 'core4 binding generation produced no TypeScript files; destination unchanged' >&2
  exit 1
fi
# Both generators succeeded. Before touching DEST, account for every committed
# binding: each must either be produced by this run or be listed in
# hand-maintained.txt (bindings core4 does not export; the README lists them
# separately and the provenance line never claims them).
declare -A produced=() hand=()
for file in "${meteo_files[@]}" "${forecast_files[@]}"; do produced["$(basename "$file")"]=1; done
if [[ -f "$HAND_MAINTAINED_LIST" ]]; then
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    entry="${entry%%#*}"; entry="${entry//[[:space:]]/}"
    [[ -n "$entry" ]] && hand["$entry"]=1
  done < "$HAND_MAINTAINED_LIST"
fi
orphans=() stale=()
for existing in "$DEST"/*.ts; do
  name="$(basename "$existing")"
  [[ "$name" == index.ts ]] && continue
  [[ -n "${produced[$name]:-}" || -n "${hand[$name]:-}" ]] || orphans+=("$name")
done
for name in "${!hand[@]}"; do [[ -n "${produced[$name]:-}" ]] && stale+=("$name"); done
if (( ${#orphans[@]} > 0 )); then
  echo "Committed bindings not produced by this core4 run and not listed in hand-maintained.txt; destination unchanged:" >&2
  printf '  %s\n' "${orphans[@]}" >&2
  echo "Delete them, or list them in $HAND_MAINTAINED_LIST and in the README's hand-maintained section." >&2
  exit 1
fi
if (( ${#stale[@]} > 0 )); then
  echo "core4 now generates files that hand-maintained.txt still lists as hand-maintained; destination unchanged:" >&2
  printf '  %s\n' "${stale[@]}" >&2
  echo "Remove them from $HAND_MAINTAINED_LIST and the README's hand-maintained section, then rerun." >&2
  exit 1
fi
copied=0
for file in "${meteo_files[@]}" "${forecast_files[@]}"; do
  [[ "$(basename "$file")" == index.ts ]] && continue
  sed -i 's|from "\./\([^"]*\)"|from "./\1.js"|g' "$file"
  cp "$file" "$DEST/$(basename "$file")"
  copied=$((copied + 1))
done
PROVENANCE="Generated from core4 commit: $CORE4_SHA ($copied bindings from meteo-types and forecast-score; the hand-maintained files listed above were not generated)."
if grep -q '^Generated from core4 commit:' "$DEST/README.md"; then
  sed -i "s|^Generated from core4 commit:.*|$PROVENANCE|" "$DEST/README.md"
else
  printf '\n%s\n' "$PROVENANCE" >> "$DEST/README.md"
fi
printf '==> Copied %s core4 bindings to %s\n' "$copied" "$DEST"
