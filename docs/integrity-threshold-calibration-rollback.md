# Integrity Threshold Calibration Rollback Runbook

## Purpose
Revert threshold calibration config to a prior known-good version when fairness or false-positive regressions are detected.

## Trigger Conditions
- False-positive rate exceeds the policy target for two consecutive windows.
- Actor-class parity gap exceeds configured threshold.
- Production moderation backlog spikes after calibration activation.

## Rollback Procedure
1. Query available configs:
   - `GET /api/integrity/calibration/config`
2. Confirm current active config:
   - `GET /api/integrity/calibration/config/active`
3. Choose rollback target version (previous stable candidate).
4. Execute rollback:
   - `POST /api/integrity/calibration/config/rollback`
   - Body:
     ```json
     {
       "targetVersion": "<stable-version>",
       "requestedBy": "<operator>",
       "reason": "<incident-reference>"
     }
     ```
5. Verify active config changed:
   - `GET /api/integrity/calibration/config/active`
6. Confirm audit trail entry exists:
   - `GET /api/integrity/calibration/audit`

## Post-Rollback Validation
- Re-run calibration suite with last known labeled dataset.
- Confirm fairness metrics and FP rate return to expected range.
- Keep candidate config in non-active state until review sign-off.
