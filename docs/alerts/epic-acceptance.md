# Early-warning epic acceptance record

Refs wrfcoin/core4-archive#3573. This is an implementation/research handoff,
not owner acceptance or permission to deliver warnings.

| Criterion | Status | Evidence / remaining decision |
|---|---|---|
| A1 alert engine | DONE for shadow research; live producer DEFERRED-WITH-REASON | Engine, persisted state adapter, read-only JWT route, reversible manual SQL and property tests. Backend has no verified oracle-tier/reference export adapter; no live producer is wired. |
| Historical false-alarm measurement | DEFERRED-WITH-REASON | Replay tool and first report exist; eligible historical windows = 0. Synthetic 12-window metrics are harness evidence only. Need matched verified observations and adjudicated outcomes. |
| A2 SMS | DONE for offline dry-run research; delivery DEFERRED-WITH-REASON | Hashed subscriptions, consent/STOP, English/French GSM-7, rate/budget caps, shared inbound envelope boundary. No public opt-in endpoint, phone routing, live sender or ownership-verification adapter. Default budget zero. |
| A3 mobile | DONE for foreground research implementation, pending independent review | Default-off device-local subscription view and shadow polling. No push or server subscription sync under transport P. See public mobile ep-warnings/foreground-alerts PR and its tests/screenshots. |
| A4 exploration | DONE as draft research, pending ratification | Public core4 ep-warnings/pilot-research PR: sources, candidate partners, liability questions and no-go recommendation. |
| A1–A4 closed or explicitly deferred with owner note | OWNER-DECISION | Archive issues remain read-only and open; this lane cannot supply an owner note or close them. Implementation PRs do not satisfy owner acceptance automatically. |
| Pilot chosen with official source | OWNER-DECISION | Kenya offline feasibility study recommended; KMD source mapped. No pilot selected; station-density evidence absent. Malawi/Madagascar alternatives mapped in draft. |
| Never contradict official: policy written and tested | DONE for implemented shadow boundary | official-precedence-policy.md and engine + mounted-route tests. Live CAP adapter/licence/coverage validation deferred until an official feed is selected. |
| Disclaimer and liability reviewed before public alerts | OWNER-DECISION | Draft wording and local-counsel questions only; legal review and insurance/funding decisions outstanding. No public alert is sent. |

Owner decisions still open: pilot geography/cells; error/missed-event acceptance
bounds; regional thresholds and languages after local review; partner selection and
feed reuse permission; counsel-reviewed consent/liability/insurance posture; funding
and transport approval before any delivery. Push transport P, zero budget and no
Firebase are settled and are not re-opened here.

SQL migrations were reviewed as reversible source, not applied to any database.
Tests do not establish deployed migration state, live data provenance, device
acceptance, gateway readiness or a measured operational false-alarm rate.
