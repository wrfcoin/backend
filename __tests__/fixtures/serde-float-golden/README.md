# Serde float provenance (Refs #1360)

Run `node __tests__/fixtures/serde-float-golden/check.mjs` from the backend root.
The checker runs the adjacent generator with cached, offline Cargo dependencies,
three build jobs, and this fixture directory's own target. It compares all 52 raw
and quantized output strings, including the literal raw negative-zero spelling
`-0.0`. JavaScript's normalized quantized zero remains `0`.

The manifest pins serde_json to 1.0.149 with float_roundtrip disabled, matching
the generator described by the regression suite. This check needs a local Rust
toolchain and cache; it makes no live request and changes no chain schedule.
