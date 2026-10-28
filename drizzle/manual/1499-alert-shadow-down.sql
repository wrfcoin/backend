-- Rollback discards shadow research state; export it first if retention is required.
BEGIN;
DROP TABLE IF EXISTS alert_shadow_state;
COMMIT;
