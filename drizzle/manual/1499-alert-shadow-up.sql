-- Apply only through an approved migration window; this sprint does not run DDL.
BEGIN;
CREATE TABLE alert_shadow_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object')
);
COMMIT;
