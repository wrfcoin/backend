# @wrfcoin/generated-types

Auto-generated, single-source-of-truth TypeScript bindings for the WRFCoin platform.
The types are generated from the Rust ecosystem crates (`meteo-types`, `forecast-score`)
via [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) so that the backend, frontend, and
mobile clients all share the exact same wire shapes and avoid type-system drift.

> **Do not edit the generated `*.ts` source files by hand** — they are regenerated. See
> `backend/scripts/generate-rust-types.sh`. The exceptions are the hand-maintained
> bindings listed under "Hand-maintained bindings (not generated from core4)" below.

## Why this package exists

`frontend` and `backend` are independent git repositories (no submodules), so the frontend
cannot import these types across a sibling checkout. Packaging them as a versioned
package gives every consumer one canonical definition. Unblocks `frontend#152` / `frontend#160`.

## Installation

> **Never published to public npm** (owner ruling 2026-10-03). `package.json` is `"private": true`,
> so npm is documented to refuse publishing it. Consume it from a tarball or from a private package
> registry. (npm cannot install a subdirectory of a git repository, so there is no git-URL install: a
> repo-root git URL would install the whole backend, not this package.)

```bash
# build the tarball from this repo, then install it from where you saved it
(cd shared/generated-types && npm pack)          # writes wrfcoin-generated-types-<version>.tgz
npm install /path/to/wrfcoin-generated-types-0.1.0.tgz
```

## Usage

```ts
import type {
  WeatherObservation,
  EnvironmentalReport,
  ForecastAccuracyMetrics,
} from '@wrfcoin/generated-types';
```

Fields use Rust/snake_case naming (e.g. `temperature_c`, `data_quality_score`). Frontend
code that prefers camelCase should add a thin adapter layer rather than re-declaring the types.

Every binding is also importable individually:

```ts
import type { WeatherObservation } from '@wrfcoin/generated-types/WeatherObservation';
```

## Build

This is a **type-only** package. `tsc` compiles the `.ts` sources to `.d.ts` declarations
(plus empty runtime `.js` modules, since every export is `export type`) under `dist/`:

```bash
npm run build      # tsc -p tsconfig.build.json  -> dist/
```

`prepack` / `prepublishOnly` run the build automatically, so the published tarball always
contains compiled `dist/` output and never raw sources.

## Publishing

Publishing is a gated, credentialed step performed by a maintainer (not by automation):

```bash
cd backend/shared/generated-types
npm version <patch|minor|major>   # bump version
npm publish                        # runs prepublishOnly -> build, then publishes
```

The version should be bumped whenever the upstream Rust types change and the bindings are
regenerated.

## Generator source and provenance

`scripts/generate-rust-types.sh` reads `CORE4_DIR/meteo-types` and
`CORE4_DIR/forecast-score`, the vendored crates compiled by the node today.
Set `CORE4_DIR` to the approved regeneration lane's checkout. This is not a
ruling on the future canonical repositories. Both manifests must exist before
Cargo runs; fresh temporary ts-rs output prevents stale bindings from being
copied. The crates' `export_to = "bindings/"` is relative to the explicitly
selected `TS_RS_EXPORT_DIR`, so the script copies that nested directory.

## Hand-maintained bindings (not generated from core4)

core4's `meteo-types` and `forecast-score` crates do not export these types, so the
generator never produces them. They are retained from the earlier standalone-crate
generator (their ts-rs header is historical), are maintained by hand until core4
exports them, and are never covered by the provenance line below. The machine-readable
list is `hand-maintained.txt`; the generator fails if any other committed binding is
not produced by a run, or if core4 starts producing a file listed here.

- `AccuracyWindow.ts`
- `ForecastAccuracyMetrics.ts`
- `Pair.ts`
- `SensorAccuracyBand.ts`
- `SensorAccuracyMetrics.ts`
- `SensorReferencePair.ts`

## Provenance

Generated from core4 commit: f9cb5609614b (21 bindings from meteo-types and forecast-score; the hand-maintained files listed above were not generated).

After an approved regeneration the script replaces this line with the core4
`git describe --always --dirty --abbrev=12` result (a `-dirty` suffix means the
checkout had uncommitted changes) and the number of bindings it generated.
`CORE4_DIR` must be a git checkout, not a `git archive` export. Run the
binding/script tests and typecheck before committing generated changes. The
#1174 validation uses a stub `cargo` plus static and shell syntax/lint checks;
it does not claim a local Cargo regeneration.
