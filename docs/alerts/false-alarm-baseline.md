# False-alarm baseline: NOT YET MEASURED ON HISTORICAL DATA

Refs wrfcoin/backend-archive#1499 and wrfcoin/core4-archive#3573.

The repository's provider-alert fixtures contain alert payloads, not paired verified
station observations, oracle quality/reference provenance and observed outcomes.
No eligible historical windows were located. No public API export was made: no
known public route was found with the required joined verification/outcome fields.
No private node port or host was contacted. Historical precision, recall and
false-alarm rate are **unavailable**, not zero. Delivery remains absent.

Reproduce the offline harness (Node 24):

```
npx tsx scripts/replay-shadow-alerts.ts __tests__/fixtures/alerts/synthetic.json
```

| Evidence | Hazard | Windows | TP | FP | FN | TN | Precision | Recall | False-alarm ratio | False-positive rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Synthetic only | rain | 4 | 1 | 1 | 1 | 1 | 0.50 | 0.50 | 0.50 | 0.50 |
| Synthetic only | heat | 4 | 1 | 1 | 1 | 1 | 0.50 | 0.50 | 0.50 | 0.50 |
| Synthetic only | wind | 4 | 1 | 1 | 1 | 1 | 0.50 | 0.50 | 0.50 | 0.50 |
| Historical | all | 0 | — | — | — | — | unavailable | unavailable | unavailable | unavailable |

Definitions: precision = TP/(TP+FP), recall = TP/(TP+FN), false-alarm ratio =
FP/(TP+FP), false-positive rate = FP/(FP+TN). A zero denominator returns null.
A positive official alert or observed positive outcome labels a positive; absent
warnings alone do not label a negative. Unknown outcomes are counted separately.
Scores include suppressed detector candidates, so official precedence does not
artificially remove true positives. These are cell/hazard/window scores, not
independent storm scores. Correlated windows require clustering before inference.

Config is emitted with every replay: research region; rain rate 30 mm/h, rolling
hour accumulation 30 mm, heat index 40.56 C, gust 25.93 m/s; two stations;
freshness 600000 ms, cooldown 3600000 ms, release ratio 0.8. No pressure input.
See thresholds.md for sources and the interim trust rule. Synthetic station tokens
carry no owner names. Do not relabel this generated fixture as historical evidence.

Next data requirement: matched, independently adjudicated positive AND negative
cell/hazard windows across seasons, verified source provenance, complete official
warning coverage and unknown-outcome accounting. A provisional planning target is
at least 100 independent positive episodes and 100 negative windows per hazard
per pilot region. This is an engineering collection target, not an acceptance
threshold or a guarantee of statistical precision. The owner and pilot experts
must choose acceptable error bounds and missed-event costs before delivery exists.

SMS false-alarm rate is also unavailable: there is no delivered-message history.
A dry-run template preview cannot establish a human-warning performance rate.
